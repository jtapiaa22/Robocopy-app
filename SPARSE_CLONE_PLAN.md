# Plan: Clone Inteligente (origen puede ser mayor al destino)

## Estado: PLANIFICADO — no implementado todavía

---

## 0. Resumen ejecutivo

El clone actual copia sector a sector, por lo que el destino debe ser >= origen.
Este plan permite clonar a un disco más chico copiando **solo los clusters con
datos**, usando el bitmap de asignación que Windows expone por ioctl.

Hay dos estrategias posibles. Ambas quedan documentadas; hay que elegir una
antes de implementar:

| | Estrategia A: copia sparse + parche de boot sector | Estrategia B: encoger origen → clonar → restaurar |
|---|---|---|
| Toca el disco origen | No (solo lectura) | Sí (shrink temporal, reversible) |
| Consistencia del filesystem destino | **Riesgosa** — metadata interna queda inconsistente (ver §8.1) | Garantizada — Windows mantiene el FS consistente |
| Código nuevo | Mucho (bitmap, runs, parches, tablas) | Poco (PowerShell + el clone actual) |
| Límite de encogimiento | Posición del último cluster usado | Posición del último cluster *inamovible* (suele ser peor) |
| Velocidad | Copia solo datos usados | Copia hasta el tamaño encogido (incluye huecos internos) |

**Recomendación**: prototipar B primero (días de trabajo, bajo riesgo) y medir
si su límite de shrink alcanza para los casos reales. Implementar A solo si B
se queda corta. El resto del documento desarrolla A en detalle, con B en §9.

---

## 1. Por qué el clone actual no puede ir a disco más chico

El clone actual hace esto:
```
leer sector 0 → escribir sector 0
leer sector 1 → escribir sector 1
...
leer sector N → escribir sector N   ← si N > sectores del destino, no hay dónde escribir
```

Es ciego. No sabe qué sectores tienen datos reales y cuáles son espacio libre.
Si el origen tiene 500 GB y el destino 250 GB, se queda sin espacio a mitad de camino.

---

## 2. La solución: leer solo los clusters con datos

### API clave: FSCTL_GET_VOLUME_BITMAP

Windows expone esta ioctl en cualquier volumen montado (`\\.\D:`, `\\.\E:`, etc.).
Devuelve un mapa de bits donde:
  - 1 bit = 1 cluster del filesystem
  - bit = 1 → ese cluster tiene datos
  - bit = 0 → ese cluster está libre

No necesitamos entender NTFS ni FAT internamente. Windows ya sabe qué clusters usa.

```
Código IOCTL: 0x0009006F   (= CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 27, METHOD_NEITHER, FILE_ANY_ACCESS))

Input  (8 bytes): STARTING_LCN_INPUT_BUFFER { StartingLcn: i64 }
Output (VOLUME_BITMAP_BUFFER):
  { StartingLcn:  i64,     (8 bytes) → primer cluster representado en el buffer
    BitmapSize:   i64,     (8 bytes) → cantidad de clusters representados
    Buffer:       [u8; ?]  (1 bit por cluster, redondeado al byte) }

Para leer el bit del cluster N (relativo a StartingLcn):
  byte = N / 8
  bit  = N % 8
  usado = (Buffer[byte] >> bit) & 1 == 1
```

**Detalles de implementación que NO son opcionales:**

1. **El buffer puede no alcanzar.** Si el buffer de salida es chico, `DeviceIoControl`
   falla con `ERROR_MORE_DATA` (234) pero devuelve un fragmento válido. Hay que
   iterar: repetir la llamada con `StartingLcn = StartingLcn_devuelto +
   clusters_recibidos` hasta cubrir todo el volumen. Conviene iterar con buffers
   de ~16 MB en lugar de pedir todo de una (un volumen de 8 TB con clusters de
   4K necesita ~256 MB de bitmap).
2. **El `StartingLcn` devuelto puede ser menor al pedido** (el FS lo redondea
   hacia abajo a múltiplos de 8). Usar siempre el valor devuelto, no el pedido.
3. **Los bits sobrantes del último byte son basura.** Si `BitmapSize` no es
   múltiplo de 8, enmascarar los bits que exceden `BitmapSize`.
4. **El bitmap es una foto del momento.** Si el volumen sigue montado y activo,
   puede cambiar mientras copiamos → ver §8.2 (lock del volumen).

### Vocabulario

| Término | Definición |
|---|---|
| Sector | Unidad lógica mínima del disco. Casi siempre 512 bytes, pero existen discos 4Kn → verificar con IOCTL_DISK_GET_DRIVE_GEOMETRY_EX, no asumir |
| Cluster | Agrupación lógica del filesystem. En NTFS (volumen > 2 GB) típicamente 4096 bytes = 8 sectores. Obtener el real con GetDiskFreeSpaceW |
| LCN | Logical Cluster Number: número de cluster desde el inicio del VOLUMEN |
| LBA | Número de sector desde el inicio del DISCO físico (empieza en 0) |
| Partition offset | Byte donde empieza la partición dentro del disco físico (Get-Partition lo da directo en bytes) |
| Cluster bitmap | Array de bits. Bit N = cluster N del volumen. 1=ocupado, 0=libre |
| Run | Serie de clusters consecutivos con el mismo estado (todos usados o todos libres) |

### Dónde leer y dónde escribir (simplificación importante)

**Lectura del origen: por el handle del VOLUMEN, no del disco físico.**
Al abrir `\\.\D:` los offsets de lectura son relativos al inicio del volumen:

```
offset_lectura = LCN × cluster_size          ← sin aritmética de partición
```

**Escritura al destino: por el handle del DISCO físico** (el destino no tiene
volúmenes montados después de Clear-Disk):

```
offset_escritura = partition_offset_destino + LCN × cluster_size
```

Esto elimina la mitad de la aritmética de offsets y la mitad de los errores
posibles. Para posicionarse se usa `SetFilePointerEx` antes de cada
ReadFile/WriteFile.

Con `FILE_FLAG_NO_BUFFERING`, offsets y tamaños deben ser múltiplos del sector:
los runs siempre lo cumplen (los clusters son múltiplos de 512), y la alineación
del buffer en memoria ya está resuelta en el código actual (`align_offset(512)`).

**Los runs se trocean en chunks** (ej. 4 MB) aunque sean contiguos: un run de
80 GB en una sola operación de I/O impediría reportar progreso y cancelar.

---

## 3. Qué hay que parchear en el disco destino

Después de copiar, el filesystem del destino tiene en su boot sector el tamaño
del ORIGEN (porque copiamos esos bytes también). Hay que actualizarlo.

### NTFS — boot sector (primeros 512 bytes de la partición)

```
Offset 0x28 (40 decimal) → TotalSectors → 8 bytes (QWORD, little-endian)
```

**Dos detalles que el parche simple omite y rompen el volumen:**

1. `TotalSectors` en NTFS es `sectores_de_la_partición - 1`: el último sector
   de la partición queda FUERA del volumen, reservado para el **backup boot
   sector**.
2. NTFS guarda una **copia del boot sector en ese último sector**. chkdsk y el
   montaje la verifican. Después de parchear el boot sector hay que escribir la
   misma copia parcheada en `partition_offset + partition_size - 512`.

### FAT32 — boot sector

```
Offset 0x20 (32 decimal) → TotalSectors32 → 4 bytes (DWORD)
```

FAT32 además tiene backup del boot sector (típicamente el sector 6 de la
partición; el offset real está en el campo BkBootSec, offset 0x32 del BPB) →
parchear ambos. El FSInfo (cuenta de clusters libres) quedará desactualizado;
es solo un hint, chkdsk lo corrige.

### exFAT — boot sector

```
Offset 0x48 (72 decimal) → VolumeLength → 8 bytes (QWORD) → EN SECTORES
```

⚠ **Corrección sobre la versión anterior de este plan: VolumeLength está en
SECTORES, no en clusters.**

exFAT es el más delicado de parchear:
- El sector 11 de la partición contiene un **checksum de los sectores 0–10**.
  Cambiar un byte del boot sector sin recalcular ese checksum → volumen inválido.
- Hay una **boot region de backup completa en los sectores 12–23** (con su
  propio checksum en el sector 23) → repetir el parche y el checksum ahí.

### ⚠ Limitación de fondo de TODOS estos parches → ver §8.1

El boot sector es solo la "portada" del filesystem. La metadata interna
($Bitmap de NTFS, las tablas FAT, el allocation bitmap de exFAT) sigue
dimensionada para el volumen ORIGINAL más grande. El parche del boot sector no
arregla eso. Es el riesgo #1 de la Estrategia A.

---

## 4. Qué pasa con la tabla de particiones

### Opción recomendada: que Windows escriba la tabla

En lugar de escribir MBR/GPT a mano, después de `Clear-Disk` crear las
particiones con PowerShell:

```powershell
Initialize-Disk -Number N -PartitionStyle MBR   # o GPT, igual que el origen
New-Partition -DiskNumber N -Offset <bytes> -Size <bytes> -MbrType ...  # o -GptType "{guid}"
```

Windows escribe el MBR o el GPT completo (headers, backup header al final del
disco, CRC32s, protective MBR) sin que tengamos que tocar un byte. Solo hay que
replicar offset, tamaño y tipo de cada partición del origen
(`Get-Partition | Select Offset, Size, MbrType/GptType, IsActive`).

Después se copia el CONTENIDO de cada partición por encima (la partición creada
queda RAW hasta que llegan el boot sector y los datos del origen).

Esto elimina por completo las secciones de "escribir MBR a mano" y "recalcular
CRC32 de GPT". Quedan abajo solo como referencia por si la opción PowerShell
resulta inviable en la práctica.

### Referencia: MBR a mano (solo si New-Partition no sirve)

El MBR vive en el sector 0 del disco. 4 entradas de 16 bytes desde el offset 446:
```
  +0  : estado (0x80 = booteable)
  +1  : CHS inicio (3 bytes, obsoleto, ignorar)
  +4  : tipo de partición (0x07 = NTFS/exFAT, 0x0C = FAT32 LBA, etc.)
  +5  : CHS fin (3 bytes, obsoleto, ignorar)
  +8  : LBA inicio  → 4 bytes
  +12 : LBA tamaño  → 4 bytes → actualizar con el nuevo tamaño
```

### Referencia: GPT a mano (solo si New-Partition no sirve)

Hay que actualizar y mantener coherentes:
- Header primario (LBA 1): `AlternateLBA` (→ último LBA del disco destino),
  `LastUsableLBA`, CRC32 de la tabla de particiones, CRC32 del propio header
  (calculado con el campo CRC en cero).
- Tabla de particiones (LBA 2–33): `FirstLBA`/`LastLBA` de cada entrada.
- Header de backup (ÚLTIMO LBA del disco destino): espejo del primario con
  `MyLBA`/`AlternateLBA` intercambiados y `PartitionEntryLBA` apuntando a la
  copia de la tabla al final; recalcular ambos CRC32.
- Protective MBR (sector 0): campo de tamaño de la partición tipo 0xEE.

Es exactamente el tipo de código propenso a errores que la opción PowerShell evita.

---

## 5. Algoritmo completo paso a paso (Estrategia A)

```
ENTRADA: source_index, dest_index, expand_partition (bool)

━━ FASE 0: VALIDACIONES PREVIAS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

0a. BitLocker en alguna partición del origen → no ofrecer modo sparse
    (el bitmap no refleja el contenido cifrado real; solo clone sector a
    sector con destino >= origen). Detección: Get-BitLockerVolume.
0b. Dirty bit del volumen origen (fsutil dirty query X:) → si está sucio,
    pedir chkdsk antes de clonar.
0c. Tamaño de sector lógico de ambos discos (IOCTL_DISK_GET_DRIVE_GEOMETRY_EX).
    Si difieren (512e vs 4Kn) → ABORTAR con mensaje claro (offsets y boot
    sectors no son trasladables entre tamaños de sector distintos).

━━ FASE 1: ANÁLISIS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Leer esquema del disco origen (Get-Partition):
   - Tipo tabla: MBR o GPT
   - Por cada partición: { offset_bytes, size_bytes, drive_letter, tipo, filesystem }

2. Por cada partición:
   a. Sin letra o filesystem desconocido (EFI, MSR, Recovery, RAW):
      → modo = "sector_a_sector", min_size = tamaño original

   b. Con letra y NTFS / FAT32 / exFAT:
      → FSCTL_GET_VOLUME_BITMAP (iterando, §2)
      → último cluster usado = mayor LCN con bit=1
      → min_size = (último_LCN + 1) × cluster_size + cluster_size
        (margen de 1 cluster; en NTFS cubre además el backup boot sector)
      → modo = "sparse"

3. Layout v1 (decisión de alcance, ver §8.4):
   SOLO se encoge la ÚLTIMA partición; todas las anteriores conservan
   offset y tamaño originales.
   min_total = offset de la última partición + min_size de la última
   Si min_total > tamaño disco destino → ERROR con desglose por partición

━━ FASE 2: PREPARAR DESTINO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

4. Emitir "Limpiando disco destino..."
5. Clear-Disk (ya implementado) + pausa 800 ms

━━ FASE 3: CREAR PARTICIONES EN DESTINO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

6. Initialize-Disk con el mismo estilo (MBR/GPT) que el origen
7. New-Partition por cada partición: mismo offset y tipo; mismo tamaño,
   salvo la última que toma min_size. (Extenderla después depende de que
   chkdsk haya reparado la metadata interna — ver §8.1 y paso 16.)
8. Quitar letras auto-asignadas en el destino (Remove-PartitionAccessPath)
   para que nada escriba ahí durante la copia.

━━ FASE 4: BLOQUEAR ORIGEN Y COPIAR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

9. Por cada volumen origen con letra: FSCTL_LOCK_VOLUME (ver §8.2).
   Si falla (archivos abiertos) → advertir "la copia puede salir
   inconsistente" y dejar elegir entre continuar o abortar.

10. Para cada partición en orden:

    [sector_a_sector]
    → leer del PhysicalDrive origen desde partition_offset_src,
      escribir al PhysicalDrive destino desde partition_offset_dst

    [sparse]
    → handle de lectura: \\.\X:  (volumen origen)
    → handle de escritura: PhysicalDrive destino
    → por cada run de clusters usados consecutivos:
         por cada chunk de hasta 4 MB dentro del run:
           SetFilePointerEx(src_vol, LCN×cluster_size)
           ReadFile(...)
           SetFilePointerEx(dst_disk, part_offset_dst + LCN×cluster_size)
           WriteFile(...)
           progreso += chunk; chequear cancel
    → clusters libres: NO se escriben (el destino quedó en cero con Clear-Disk)

━━ FASE 5: PARCHEAR BOOT SECTORS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

11. Para cada partición "sparse" cuyo tamaño cambió:
    → detectar FS por magic bytes ("NTFS    ", "EXFAT   ", BPB de FAT32)
    → NTFS : TotalSectors (0x28) = nuevos_sectores_partición - 1
             + escribir copia del boot sector parcheado en el último sector
    → FAT32: TotalSectors32 (0x20) + backup en el sector BkBootSec
    → exFAT: VolumeLength (0x48, EN SECTORES)
             + recalcular checksum (sector 11) + boot region backup (12–23)

━━ FASE 6: POST-PROCESO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

12. Soltar locks del origen (CloseHandle)
13. Nueva firma/GUID de disco en el destino (ya implementado: diskpart uniqueid)
14. Set-Disk -IsOffline $false ; Update-Disk
15. chkdsk /f sobre cada volumen sparse del destino (ver §8.1 — NO es opcional)
16. Si expand_partition y chkdsk dejó el FS sano: Resize-Partition al máximo
```

---

## 6. Cambios en el código (cuando se implemente)

### lib.rs — nuevas funciones

```rust
struct VolumeBitmap {
    bitmap_size: u64,     // total de clusters del volumen
    buffer: Vec<u8>,      // 1 bit por cluster (bits sobrantes ya enmascarados)
    cluster_size: u64,    // bytes por cluster
}

// Itera FSCTL_GET_VOLUME_BITMAP hasta cubrir el volumen (maneja ERROR_MORE_DATA)
fn get_volume_bitmap(drive_letter: &str) -> Result<VolumeBitmap, String>

fn last_used_cluster(bitmap: &VolumeBitmap) -> Option<u64>

// Itera runs usados y copia por chunks, leyendo del volumen y escribiendo al disco
fn copy_sparse(
    src_vol: *mut c_void,          // handle \\.\X: (volumen origen)
    dst_disk: *mut c_void,         // handle PhysicalDrive destino
    bitmap: &VolumeBitmap,
    dst_partition_offset: u64,     // bytes desde el inicio del disco destino
    app: &tauri::AppHandle,
    cancel: &Arc<AtomicBool>,
) -> Result<u64, String>           // bytes copiados

// Parchea TotalSectors/VolumeLength según FS + copias de backup + checksums
fn patch_boot_sector(
    dst_disk: *mut c_void,
    partition_offset: u64,
    new_partition_size: u64,
) -> Result<(), String>
```

### lib.rs — nuevo comando Tauri

```rust
// Solo analiza, no copia. El frontend lo llama al seleccionar ambos discos.
#[tauri::command]
async fn analyze_clone(source_index: u32, dest_index: u32) -> Result<CloneAnalysis, String>

struct PartitionAnalysis {
    letter: Option<String>,
    filesystem: String,       // "ntfs" | "fat32" | "exfat" | "raw" | ...
    original_size: u64,
    used_bytes: u64,          // suma de clusters con bit=1 (lo que se va a copiar)
    min_required: u64,        // (último_LCN+1) × cluster_size + margen — NO es used_bytes
    clone_mode: String,       // "sparse" | "sector_by_sector"
    bitlocker: bool,
}

struct CloneAnalysis {
    can_fit: bool,
    sector_size_mismatch: bool,
    partitions: Vec<PartitionAnalysis>,
    total_min_required: u64,
    total_used_data: u64,     // para estimar tiempo de copia
}
```

Nota: `used_bytes` (datos a copiar) y `min_required` (espacio que exige el
destino) son cosas distintas — por la fragmentación, `min_required` puede ser
mucho mayor. La UI debe mostrar ambos.

### disk_win mod — agregar

```rust
pub const FSCTL_GET_VOLUME_BITMAP: u32 = 0x0009006F;
pub const ERROR_MORE_DATA: u32 = 234;

pub fn SetFilePointerEx(
    hfile: *mut c_void,
    li_distance_to_move: i64,
    lp_new_file_pointer: *mut i64,
    dw_move_method: u32,   // 0 = FILE_BEGIN
) -> i32;
```

### CloneDisk.jsx — cambios de UI

1. Al seleccionar origen + destino → llamar `analyze_clone` automáticamente
2. Desglose por partición:
   "Partición C: (NTFS) — 150 GB de datos, necesita 158 GB en destino (por fragmentación)"
3. `can_fit = false` → botón deshabilitado + mensaje con opciones (disco más
   grande / desfragmentar el origen)
4. Origen > destino pero `can_fit = true` → aviso verde "Los datos caben"
5. Tiempo estimado basado en `total_used_data`, no en el tamaño del origen

---

## 7. Ejemplo numérico

```
DISCO ORIGEN: 500 GB (base 10) = 500.000.000.000 bytes
  Sectores totales: 976.562.500   (500e9 / 512)
  Tabla: MBR

  Partición única NTFS:
    Inicio: LBA 2048 (offset 1.048.576 bytes)
    Tamaño: ~976.560.000 sectores ≈ 499,9 GB
    Cluster: 4096 bytes → ~122.070.000 clusters
    Usados:  ~44.000.000 clusters ≈ 180 GB
    Último cluster usado: #45.800.000  (posición ~37% del volumen)

DISCO DESTINO: 250 GB = 250.000.000.000 bytes (488.281.250 sectores)
```

Análisis:
```
min_required = (45.800.000 + 1) × 4096 + 4096 ≈ 187,6 GB
¿1 MB de offset + 187,6 GB cabe en 250 GB? → SÍ

A copiar: 180 GB (los ~320 GB de clusters libres se saltan)
Clone viejo: 500 GB → ~28 min a 300 MB/s
Clone nuevo: 180 GB → ~10 min a 300 MB/s
```

Caso límite — mismos 180 GB de datos pero fragmentados hasta el final del disco:
```
Último cluster usado: #120.000.000 (posición ~98% del volumen)
min_required = 120.000.001 × 4096 ≈ 491,5 GB → NO cabe en 250 GB

Mensaje al usuario:
  "Los datos ocupan 180 GB pero están distribuidos hasta el 98% del disco
   origen. Esta técnica no los puede reubicar. Opciones:
     · Desfragmentar/optimizar el origen (defrag X: /X consolida hacia el inicio)
     · Usar un disco destino de al menos 500 GB"
```

**Por qué el mínimo es la POSICIÓN del último cluster y no la SUMA de datos:**
cada cluster se copia a su mismo LCN en el destino. No podemos compactarlos:
habría que reescribir todas las referencias internas del filesystem, que es
exactamente lo que hace un desfragmentador. Por eso la fragmentación define el
mínimo. Y por eso NO se aplica un "overhead %": el mínimo es exacto, y la
versión anterior de este plan (5% de holgura) hacía fallar casos que sí caben.

---

## 8. Riesgos críticos y decisiones abiertas

### 8.1 ⚠ EL RIESGO PRINCIPAL: metadata interna inconsistente (Estrategia A)

Parchear el boot sector le dice al FS "ahora medís X sectores", pero la
metadata interna sigue describiendo el tamaño original:

- **NTFS**: el archivo `$Bitmap` tiene 1 bit por cluster del volumen ORIGINAL
  (más grande). Resultado típico: el volumen monta pero chkdsk encuentra
  errores, o directamente el driver se niega a montarlo.
- **FAT32**: la tabla FAT tiene entradas para todos los clusters originales y
  `FATSz32` del BPB sigue declarando el tamaño viejo.
- **exFAT**: ídem con su allocation bitmap.

Mitigación planificada: `chkdsk /f` automático post-clone (paso 15), que
reconstruye/trunca metadata. **Hay que VALIDAR EN PRUEBAS REALES que chkdsk
repara esto de forma confiable en los tres filesystems antes de dar la feature
por buena** (clonar → chkdsk → montar → comparar hashes de archivos). Si chkdsk
no lo repara de forma consistente, la Estrategia A no es viable tal cual y hay
que ir a la B.

### 8.2 Consistencia durante la copia

El bitmap y los datos se leen de un volumen montado que puede estar cambiando
mientras copiamos. Plan: `FSCTL_LOCK_VOLUME` sobre el origen durante toda la
copia (falla si hay archivos abiertos). Si el lock falla: advertir y dejar
elegir entre continuar (riesgo de copia inconsistente) o abortar. VSS
(snapshot) sería la solución perfecta pero queda fuera de alcance por
complejidad.

**Nota**: esto también aplica al clone sector-a-sector ACTUAL (hoy copia el
origen montado y caliente). Vale la pena agregar el lock del origen al clone
actual independientemente de este plan.

### 8.3 Clones booteables

Ya hoy se cambia la firma del disco destino (uniqueid) para evitar la colisión
de firmas. El BCD de Windows referencia el dispositivo de arranque por firma de
disco + offset de partición → **un clon de un disco de sistema puede no
bootear** sin un `bcdboot`/`bootrec /rebuildbcd` posterior. No es regresión de
este plan (ya pasa hoy con el clone actual), pero hay que documentarlo en la
UI: "clonar disco de datos: OK; disco de Windows: puede requerir reparación de
arranque".

### 8.4 Alcance v1 (decisiones propuestas)

1. **Solo se encoge la ÚLTIMA partición.** Las demás se copian idénticas
   (offset y tamaño). Layouts con Recovery DESPUÉS de C: (muy comunes en
   equipos de fábrica) → v1 ofrece omitir la partición Recovery (checkbox con
   aviso) o aborta. Reubicar particiones queda para v2.
2. **MBR y GPT soportados desde v1** vía Initialize-Disk/New-Partition
   (Windows escribe la tabla, §4) — la complejidad de CRC32/backup header
   desaparece.
3. **Particiones sin letra** (EFI, MSR, Recovery): sector a sector, tamaño
   original. Si no caben en el destino → error claro.
4. **BitLocker**: detectado → solo se ofrece el clone clásico (destino >= origen).
5. **Discos 4Kn**: si el tamaño de sector lógico difiere entre origen y
   destino → abortar.

---

## 9. Estrategia B: encoger origen → clonar → restaurar

La alternativa con menos código y filesystem garantizado consistente:

```
1. ANÁLISIS: Get-PartitionSupportedSize en el origen → SizeMin
   (Windows ya calcula el mínimo encogible, considerando archivos inamovibles)

2. Si SizeMin (+ offsets) <= tamaño del destino:
   a. Resize-Partition origen → SizeMin + margen      ← Windows reubica
      clusters y mantiene TODO consistente ($Bitmap, FAT, boot sector, backups)
   b. Clonar sector a sector SOLO hasta el fin de la última partición
      (el código actual con un parámetro de límite de bytes — cambio mínimo)
   c. Restaurar el origen: Resize-Partition de vuelta al máximo
   d. El destino NO necesita parches: la tabla de particiones clonada describe
      la partición YA encogida, que es válida tal cual en el disco chico.
      Solo corre el post-proceso actual (firma nueva, online, expandir).

3. Si SizeMin > destino: mismo mensaje de error, con la opción de
   desfragmentar o deshabilitar pagefile/hibernación y reintentar.
```

**Pros**: ~90% del código ya existe; el resultado monta sin chkdsk; MBR/GPT,
boot sectors y backups quedan todos bien porque nunca se inventa nada a mano.

**Contras**: escribe en el disco origen (shrink + grow, reversible pero es
escritura); si se corta la energía durante el shrink/grow el origen puede
quedar a medias; `SizeMin` suele ser peor que "último cluster usado" porque
los archivos inamovibles (pagefile.sys, hiberfil.sys, $MFT mirror) limitan el
shrink — mitigable deshabilitándolos temporalmente, pero suma pasos y reinicios.

**Criterio de decisión**: correr `Get-PartitionSupportedSize` en los discos
reales de los casos de uso típicos. Si el SizeMin típico alcanza para los
destinos típicos → implementar B. Si no → invertir en A.

---

## 10. Orden de implementación (Estrategia A, si se elige)

```
 1. Validaciones fase 0 (BitLocker, dirty bit, tamaño de sector)
 2. Agregar FSCTL_GET_VOLUME_BITMAP + SetFilePointerEx a disk_win
 3. get_volume_bitmap() con loop ERROR_MORE_DATA + prueba con volumen real
 4. last_used_cluster() + comando analyze_clone (solo análisis)
 5. UI de análisis en CloneDisk.jsx (desglose por partición, can_fit)
 6. Fase 3 con Initialize-Disk/New-Partition
 7. copy_sparse() con lock de volumen, chunks y progreso
 8. patch_boot_sector() NTFS (con backup boot sector) → probar → FAT32 → exFAT
 9. chkdsk /f automático post-clone + verificación de montaje
10. PRUEBA CRÍTICA del §8.1 con discos reales en los 3 filesystems
    (clonar → chkdsk → montar → comparar hashes de archivos)
11. Multi-partición + caso Recovery-después-de-C:
```

Para la Estrategia B el orden es trivial: analyze con SizeMin → shrink →
parámetro de límite de bytes en el clone actual → grow → post-proceso existente.
