# Plan: Clone Inteligente (origen puede ser mayor al destino)

## Estado: PLANIFICADO — no implementado todavía

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
Si el origen tiene 500 GB y el destino 250 GB, en el sector 500.000.000 se queda sin espacio.

---

## 2. La solución: leer solo los clusters con datos

### API clave: FSCTL_GET_VOLUME_BITMAP

Windows expone esta ioctl en cualquier volumen montado (\\.\D:, \\.\E:, etc.).
Devuelve un mapa de bits donde:
  - 1 bit = 1 cluster del filesystem
  - bit = 1 → ese cluster tiene datos
  - bit = 0 → ese cluster está libre

No necesitamos entender NTFS ni FAT internamente. Windows ya sabe qué clusters usa.

```
Código IOCTL: 0x0009006F

Input  (8 bytes): { starting_lcn: i64 }   → siempre 0 (empezar desde el inicio)
Output (variable):
  { starting_lcn: i64,      (8 bytes) — primer cluster del bitmap
    bitmap_size:  i64,      (8 bytes) — total de clusters en el volumen
    buffer:       [u8; ?]   (1 bit por cluster, redondeado al byte) }

Para leer el bit del cluster N:
  byte = N / 8
  bit  = N % 8
  usado = (buffer[byte] >> bit) & 1 == 1
```

### Vocabulario

| Término | Definición |
|---|---|
| Sector | Unidad física mínima del disco = 512 bytes |
| Cluster | Agrupación lógica del filesystem. En NTFS (disco > 2 GB) = 4096 bytes = 8 sectores |
| LBA | Número de sector desde el inicio del disco físico (empieza en 0) |
| Partition offset | LBA donde empieza la partición dentro del disco físico |
| Cluster bitmap | Array de bits. Bit N = cluster N del volumen. 1=ocupado, 0=libre |
| Run | Serie de clusters consecutivos con el mismo estado (todos usados o todos libres) |

### Conversión cluster → offset físico en disco

```
offset_fisico_en_disco = (partition_offset_lba × 512) + (cluster_n × cluster_size_bytes)
```

Ejemplo: partición empieza en LBA 2048, cluster size = 4096 bytes, cluster 1000:
```
offset = (2048 × 512) + (1000 × 4096)
       = 1.048.576 + 4.096.000
       = 5.144.576 bytes desde el inicio del disco
```

---

## 3. Qué hay que parchear en el disco destino

Después de copiar, el filesystem del destino tiene en su boot sector el tamaño
del ORIGEN (porque copiamos esos bytes también). Hay que actualizarlo.

### NTFS Boot Sector (primeros 512 bytes de la partición)
```
Offset 0x28 (40 decimal) → TotalSectors → 8 bytes (QWORD)

Ejemplo:
  Origen  tiene 600.000.000 sectores → TotalSectors = 600.000.000
  Destino tiene 350.000.000 sectores → hay que escribir 350.000.000 en ese offset
```

### FAT32 Boot Sector
```
Offset 0x20 (32 decimal) → TotalSectors32 → 4 bytes (DWORD)
```

### exFAT Boot Sector
```
Offset 0x48 (72 decimal) → VolumeLength → 8 bytes (QWORD, en clusters, no sectores)
```

La operación es: leer los primeros 512 bytes de la partición en el destino,
sobrescribir esos bytes en la posición correcta, escribir de vuelta. Sin parser,
sin librería de filesystem.

---

## 4. Qué pasa con la tabla de particiones

### MBR (disco con tabla de particiones vieja)
El MBR vive en el sector 0 del disco. Tiene 4 entradas de partición, cada una de 16 bytes:
```
Offset 446: entrada 1
  +0  : estado (0x80 = booteable)
  +1  : CHS inicio (obsoleto, ignorar)
  +4  : tipo de partición (0x07 = NTFS, 0x0B = FAT32, etc.)
  +5  : CHS fin (obsoleto, ignorar)
  +8  : LBA inicio → 4 bytes ← este es el que nos importa
  +12 : LBA tamaño → 4 bytes ← ESTE hay que actualizar con el nuevo tamaño
Offset 462: entrada 2
...
```

Para el destino: copiar el MBR del origen, pero actualizar el campo "LBA tamaño"
de cada partición para que refleje el nuevo tamaño.

### GPT (disco moderno)
Más complejo: tiene header en sector 1 + backup header en el ÚLTIMO sector del disco.
El backup hay que recalcularlo para la posición correcta en el disco destino.
También tiene checksums CRC32 que hay que recalcular.

**Decisión de implementación**: Para la primera versión, manejar MBR y GPT.
GPT requiere: mover backup header, recalcular CRC32 del header y de la tabla de particiones.

---

## 5. Algoritmo completo paso a paso

```
ENTRADA: source_index (número de disco origen)
         dest_index   (número de disco destino)
         expand_partition (bool)

─── FASE 1: ANÁLISIS ──────────────────────────────────────────────────────────

1. Leer esquema del disco origen (PowerShell Get-Partition):
   - Tipo tabla: MBR o GPT
   - Por cada partición: { offset_bytes, size_bytes, drive_letter, filesystem }

2. Por cada partición:
   a. Si NO tiene letra (EFI, Recovery, Reserved, sin formato):
      → modo = "sector_a_sector"
      → min_size = tamaño original de la partición

   b. Si tiene letra y filesystem conocido (NTFS / FAT32 / exFAT):
      → Abrir \\.\X: con GENERIC_READ + FILE_SHARE_READ + FILE_SHARE_WRITE
      → Llamar FSCTL_GET_VOLUME_BITMAP desde cluster 0
      → Iterar bitmap, encontrar último cluster con bit=1
      → min_data_bytes = (ultimo_cluster_usado + 1) × cluster_size
      → min_size = min_data_bytes + 5% overhead
      → modo = "sparse"

3. Calcular min_total = suma de min_size de todas las particiones + gaps entre ellas
   Si min_total > tamaño disco destino → RETORNAR ERROR con mensaje claro

─── FASE 2: PREPARAR DESTINO ──────────────────────────────────────────────────

4. Emitir evento: "Limpiando disco destino..."
5. Clear-Disk (ya implementado)
6. Pausa 800ms

─── FASE 3: ESCRIBIR TABLA DE PARTICIONES EN DESTINO ─────────────────────────

7. Leer sector 0 (MBR) o sectores 0-33 (GPT) del origen
8. Calcular nuevo layout: mismas particiones pero con nuevos tamaños
   - Mantener el mismo orden
   - Particiones "sector_a_sector": mismo tamaño exacto
   - Particiones "sparse": min_size × 1.05 (datos + 5% holgura)
   - La última partición de datos: usar todo el espacio restante del destino
     (excepto si hay particiones de recuperación al final)
9. Escribir nueva tabla de particiones en sector 0 del destino

─── FASE 4: COPIAR CADA PARTICIÓN ────────────────────────────────────────────

10. Para cada partición en orden:

    [MODO sector_a_sector]
    → Loop normal: leer chunk del origen, escribir en destino
       (posición física = partition_offset + posición dentro de la partición)

    [MODO sparse]
    → Para cada run de clusters USADOS consecutivos en el bitmap:
         offset_src = partition_offset_src + (cluster_inicio × cluster_size)
         offset_dst = partition_offset_dst + (cluster_inicio × cluster_size)
         ReadFile(src_handle, offset_src, run_size)
         WriteFile(dst_handle, offset_dst, run_size)
    → Clusters libres: NO se escriben. Destino ya está en cero (Clear-Disk).

─── FASE 5: PARCHEAR BOOT SECTORS ───────────────────────────────────────────

11. Para cada partición "sparse" en el destino:
    → Calcular nuevo_total_sectores = new_partition_size_bytes / 512
    → Leer primeros 512 bytes de la partición desde el destino
    → Detectar filesystem (magic bytes en el boot sector)
    → Escribir nuevo_total_sectores en el offset correcto
    → Escribir los 512 bytes de vuelta al destino

─── FASE 6: POST-PROCESO ─────────────────────────────────────────────────────

12. diskpart uniqueid disk → nueva firma (evita colisión con origen)
13. Set-Disk -IsOffline $false
14. Update-Disk
15. Si expand_partition: Resize-Partition en la última partición de datos
```

---

## 6. Cambios en el código (cuando lo implementemos)

### lib.rs — nuevas funciones Rust

```rust
// Obtiene el bitmap de clusters usados de un volumen montado
fn get_volume_bitmap(drive_letter: &str) -> Result<VolumeBitmap, String>

// Estructura que devuelve get_volume_bitmap  
struct VolumeBitmap {
    starting_lcn: u64,
    bitmap_size: u64,       // total de clusters
    buffer: Vec<u8>,        // 1 bit por cluster
    cluster_size: u64,      // bytes por cluster
}

// Encuentra el último cluster con datos
fn last_used_cluster(bitmap: &VolumeBitmap) -> u64

// Itera el bitmap y copia solo los runs usados
fn copy_sparse(
    src: *mut c_void,       // handle disco origen
    dst: *mut c_void,       // handle disco destino  
    bitmap: &VolumeBitmap,
    src_partition_offset: u64,  // bytes desde inicio del disco
    dst_partition_offset: u64,
    app: &tauri::AppHandle,
    cancel: &Arc<AtomicBool>,
) -> Result<u64, String>    // retorna bytes copiados

// Actualiza TotalSectors en el boot sector del filesystem
fn patch_boot_sector(
    dst: *mut c_void,
    partition_offset_bytes: u64,
    new_size_bytes: u64,
) -> Result<(), String>
```

### lib.rs — nuevo comando Tauri

```rust
// Analiza el origen y calcula si cabe en el destino ANTES de empezar
// El frontend lo llama al seleccionar ambos discos
#[tauri::command]
async fn analyze_clone(source_index: u32, dest_size_bytes: u64) -> Result<CloneAnalysis, String>

struct PartitionAnalysis {
    letter: Option<String>,
    partition_type: String,   // "ntfs" | "fat32" | "exfat" | "system" | "unknown"
    original_size: u64,
    used_size: u64,           // 0 si no tiene letra
    min_required: u64,        // used_size + 5%
    clone_mode: String,       // "sparse" | "sector_by_sector"
}

struct CloneAnalysis {
    can_fit: bool,
    partitions: Vec<PartitionAnalysis>,
    total_min_required: u64,
    total_used_data: u64,
}
```

### CloneDisk.jsx — cambios de UI

1. Al seleccionar origen + destino → llamar `analyze_clone` automáticamente
2. Mostrar desglose por partición:
   - "Partición C: (NTFS) — usa 150 GB de 297 GB → necesita 158 GB mínimo"
3. Si `can_fit = false`: deshabilitar botón + mensaje claro
4. Si origen > destino pero `can_fit = true`: mostrar aviso verde "Los datos caben"
5. Mostrar tiempo estimado basado en `total_used_data` (no en tamaño del origen)

### disk_win mod — nueva constante

```rust
pub const FSCTL_GET_VOLUME_BITMAP: u32 = 0x0009006F;
```

### Nueva función extern en disk_win

```rust
// Para setear el puntero del archivo antes de leer/escribir en offset específico
// (necesario para reads/writes en posiciones arbitrarias del disco)
pub fn SetFilePointerEx(
    hfile: *mut c_void,
    li_distance_to_move: i64,
    lp_new_file_pointer: *mut i64,
    dw_move_method: u32,   // 0 = FILE_BEGIN
) -> i32;
```

---

---

# EJEMPLO 1 — 500 GB origen, 180 GB usados → destino 250 GB

## Datos del ejemplo

```
DISCO ORIGEN: 500 GB físicos
  Sectores totales:   1.000.000.000  (500 GB / 512 bytes)
  Tabla de particiones: MBR

  Partición única:
    Inicio: LBA 2048  (= sector 2048 = byte 1.048.576 del disco)
    Fin:    LBA 976.771.071
    Tamaño: 976.769.023 sectores = ~488 GB
    Filesystem: NTFS
    Letra: D:
    Cluster size: 4096 bytes (= 8 sectores)
    Total clusters: 976.769.023 / 8 = 122.096.127
    Usados: 46.080.000  (180 GB / 4096 bytes por cluster)
    Libres: 76.016.127  (308 GB de espacio libre)
    Último cluster con datos: #45.800.000

DISCO DESTINO: 250 GB físicos
  Sectores totales: 500.000.000
```

## Fase 1: Análisis

```
Abrir \\.\D: → FSCTL_GET_VOLUME_BITMAP

Bitmap recibido:
  bitmap_size   = 122.096.127 clusters
  buffer        = 122.096.127 bits = 15.262.015 bytes ≈ 15 MB de datos

Iterar bitmap buscando el último bit=1:
  → último cluster usado = #45.800.000

Cálculo:
  min_data  = 45.800.000 × 4096 = 187.596.800.000 bytes = 174.7 GB
  overhead  = 5% = +8.7 GB
  min_total = 183.4 GB

¿Entra en 250 GB? 183.4 GB < 250 GB → ✓ SÍ, se puede clonar

Ahorro respecto al clone viejo:
  Clone viejo copiaba: 488 GB
  Clone nuevo copia:   180 GB
  Ahorro: 308 GB (63% menos I/O)
```

## Fase 3: Nuevo layout para el destino

```
DISCO DESTINO — plan de layout:
  Sector 0: MBR (con entrada de partición actualizada)

  Partición 1:
    Inicio: LBA 2048 (igual que origen, mismo alineamiento)
    Tamaño: 490.000.000 sectores ≈ 234 GB
           (usamos casi todo el disco, dejando ~16 GB sin asignar para margen)
    Fin:    LBA 490.002.047

  Sin asignar: sectores 490.002.048 al 499.999.999 (≈ 16 GB)

MBR — entrada de partición que hay que escribir:
  Antes (origen):  LBA inicio=2048, LBA tamaño=976.769.023  (488 GB)
  Después (destino): LBA inicio=2048, LBA tamaño=490.000.000 (234 GB)
```

## Fase 4: Copia sparse — cómo se ve el bitmap

```
Bitmap simplificado (cada ▓ = 1.000 clusters = 4 MB):

Posición:  0%        37%                    100% del volumen origen
           │         │                      │
Bitmap:    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
                    DATOS (180 GB)                     LIBRE (308 GB)
                    se copian                          se saltan

Operación de I/O por run (ejemplo de runs reales):
  Run 1:  clusters 0-999.999    → 1 run de 4 GB    → 1 ReadFile + 1 WriteFile
  Run 2:  clusters 1.000.000-1.499.999 → 2 GB      → 1 ReadFile + 1 WriteFile
  (gap de clusters libres: 1.500.000-1.700.000 → SKIP)
  Run 3:  clusters 1.700.001-2.999.999 → 5 GB      → 1 ReadFile + 1 WriteFile
  ...
  Último run termina en cluster ~45.800.000
  Todo lo que viene después: clusters 45.800.001 a 122.096.127 → SKIP total

Total reads/writes en este ejemplo:
  Si los datos son relativamente contiguos (típico en NTFS):
    ~50-200 runs → 50-200 pares de ReadFile/WriteFile para 180 GB
  Si muy fragmentado: podría ser miles de runs, pero sigue siendo
    solo 180 GB de datos transferidos
```

## Fase 5: Parche del boot sector NTFS

```
Leer sector LBA 2048 del DISCO DESTINO (= inicio de la partición)
Los primeros 512 bytes contienen el BPB de NTFS.

Verificar que es NTFS: bytes 3-10 deben ser "NTFS    " (con 4 espacios)

Offset 0x28 (byte 40): campo TotalSectors
  ANTES (copiado del origen):  976.769.023  (en little-endian: 3F 4F C2 3A 00 00 00 00)
  NUEVO (tamaño del destino):  490.000.000  (en little-endian: 40 3A 33 1D 00 00 00 00)

Acción: escribir los 8 bytes nuevos en offset 40 del boot sector.
Resultado: NTFS del destino cree que el volumen tiene 234 GB. Correcto.
```

## Resultado final Ejemplo 1

```
✓ 180 GB de datos copiados (de 488 GB que tenía el origen)
✓ 308 GB de espacio libre NO copiados (ahorro de tiempo y compatibilidad con disco chico)
✓ Disco destino de 250 GB con partición NTFS de 234 GB
✓ Windows reconoce el filesystem como sano (TotalSectors correcto)
✓ ~16 GB sin asignar al final (el usuario puede extender o dejar así)

Tiempo estimado a 300 MB/s:
  Clone viejo: 488 GB / 300 MB/s = 27 minutos
  Clone nuevo: 180 GB / 300 MB/s = 10 minutos
```

---

---

# EJEMPLO 2 — 298 GB origen, 246 GB usados → destino 256 GB (caso justo)

## Datos del ejemplo

Este ejemplo es deliberadamente difícil: los datos casi llenan el origen
y el destino es solo un poco más grande que los datos usados.

```
DISCO ORIGEN: 298 GB físicos (el del usuario)
  Sectores totales:   618.475.520  (298 GB / 512)
  Tabla: MBR o GPT

  Partición única NTFS:
    Inicio: LBA 2048
    Cluster size: 4096 bytes
    Total clusters: ~77.308.416
    Usados: ~64.000.000  (246 GB / 4096)
    Libres: ~13.308.416  (51 GB de espacio libre)
    Último cluster con datos: #63.900.000
    
    IMPORTANTE: los datos están dispersos por casi todo el disco.
    El último cluster usado está en la posición 82% del volumen.

DISCO DESTINO: 256 GB físicos
  Sectores totales: 536.870.912  (256 GB / 512)
```

## Fase 1: Análisis — caso justo

```
Bitmap recibido:
  último cluster usado = #63.900.000

Cálculo mínimo:
  min_data  = 63.900.000 × 4096 = 261.734.400.000 bytes = 243.8 GB
  overhead  = 5%  = +12.2 GB
  min_total = 256 GB

¿Entra en 256 GB? 256 GB = 256 GB → ⚠ EXACTO — muy justo

Decisión del algoritmo:
  Si min_total > dest_size → ERROR
  Si min_total <= dest_size → PROCEDER (aunque sea justo)

  En este caso:
    min_total = 256.000.000.000 bytes (256 GB con overhead)
    dest_size = 274.877.906.944 bytes (256 GiB = 256 × 2^30, en realidad más)

  NOTA: 256 GB del disco ≠ 256 GiB.
  Disco "256 GB" físico = 256.000.000.000 bytes (fabricante usa base 10)
  256 GiB = 274.877.906.944 bytes

  Si el destino es 256 GB (base 10): 256.000.000.000 bytes
    min_total con 5% = 261.734.400.000 × 1.05 = 274.820.000.000 ≈ 274 GB
    274 GB > 256 GB → ✗ NO CABE

  Si el destino es 256 GiB (274 GB reales):
    274.820.000.000 < 274.877.906.944 → ✓ CABE (por muy poco)
```

## Revisión del cálculo — problema encontrado

```
PROBLEMA DETECTADO al revisar el ejemplo:

  Los datos usan 246 GB del disco. 
  El último cluster con datos está en la posición 82% del disco origen.
  Mínimo necesario = posición del último cluster × cluster_size = 243.8 GB
  Con 5% overhead = 256 GB

  Un disco destino de exactamente 256 GB (base 10) = 256.000.000.000 bytes
  El overhead del 5% excede el disco.

SOLUCIÓN: el overhead del 5% es demasiado agresivo para casos donde los
datos casi llenan el origen. Mejor calcular overhead fijo:

  min_required = posición_último_cluster_usado + (cluster_size × 1000)
                  ↑ espacio de datos exacto     ↑ solo 4 MB de margen

  Y la partición en el destino se dimensiona para llenar el disco disponible,
  no para tener exactamente el mínimo.

CORRECCIÓN en el algoritmo:
  min_required = (ultimo_cluster + 1) × cluster_size  ← sin overhead
  Si min_required > dest_disk_size → ERROR
  Si min_required <= dest_disk_size → OK, la partición usa TODO el destino
```

## Ejemplo 2 corregido con nueva lógica

```
Datos reales:
  último cluster = #63.900.000
  min_required   = 63.900.001 × 4096 = 261.734.404.096 bytes = 243.8 GB exacto

  Disco destino de "256 GB" físicos = 256.000.000.000 bytes (base 10)

  ¿243.8 GB cabe en 256 GB? ✓ SÍ — sobran ~12 GB

Nuevo layout del destino:
  Partición: LBA 2048 hasta el final del disco ← usa TODO el espacio disponible
  Tamaño partición = 256.000.000.000 - (2048 × 512) = 254.950.424.576 bytes
                   = 497.168.798 sectores

Parche NTFS:
  TotalSectors = 497.168.798 (en lugar de 618.473.472 del origen)

Resultado:
  ✓ Los 246 GB de datos caben
  ✓ La partición ocupa todo el disco destino (~244 GB)
  ✓ Quedan ~12 GB disponibles dentro de la partición (espacio libre NTFS)
  ✓ No hay espacio sin asignar (la partición ya ocupa todo el disco)
```

## Caso imposible — para comparar

```
Si el último cluster con datos estuviera en la posición 98% del volumen:
  último cluster = #75.760.000 (de 77.308.416 totales)
  min_required   = 75.760.001 × 4096 = 310.313.988.096 bytes = 289 GB

  ¿289 GB cabe en 256 GB? ✗ NO

  Mensaje al usuario:
  ─────────────────────────────────────────────────────
  Los datos están distribuidos hasta los últimos sectores
  del origen. Mínimo necesario: 289 GB.
  El disco destino tiene 256 GB → no es posible clonar.
  
  Opciones:
    · Usar un disco destino de al menos 300 GB
    · Desfragmentar el disco origen primero (consolida
      los datos hacia el inicio, reduce el "último cluster")
  ─────────────────────────────────────────────────────
```

---

---

# Resumen de lo que hay que revisar antes de implementar

## Puntos confirmados ✓

1. `FSCTL_GET_VOLUME_BITMAP` → código 0x0009006F, funciona en volúmenes montados
2. NTFS TotalSectors → offset 0x28 (40 bytes desde inicio del boot sector)
3. FAT32 TotalSectors32 → offset 0x20 (32 bytes)
4. exFAT VolumeLength → offset 0x48 (72 bytes), en clusters no sectores
5. MBR: LBA tamaño de partición → offset 12 dentro de cada entrada de 16 bytes
6. Bitmap: bit N del cluster N = buffer[N/8] >> (N%8) & 1
7. Offset físico de cluster N = partition_offset_lba×512 + N×cluster_size
8. El algoritmo de "último cluster usado" basta para saber el mínimo
9. Sin overhead % — la partición destino usa TODO el espacio disponible
10. Para SetFilePointerEx: necesario para seeks en el disco (leer/escribir en offset)

## Puntos que necesitan decisión antes de implementar

1. **GPT backup header**: disco GPT tiene copia de la tabla al final.
   Al moverla al nuevo final del disco hay que recalcular CRC32.
   → ¿Soportamos GPT en v1 o solo MBR?

2. **Múltiples particiones**: ¿qué pasa si el origen tiene C: + D: + Recovery?
   → ¿Copiamos todas las particiones o solo la principal?

3. **Volúmenes sin letra** (Recovery, EFI): no se puede abrir \\.\X: sin letra.
   → Se copian sector a sector (tamaño original). Si el destino es más chico
     y estas particiones no caben, bloqueamos con error.

4. **BitLocker**: FSCTL_GET_VOLUME_BITMAP puede fallar o dar resultados incorrectos.
   → Detectar y reportar como "no se puede analizar, clonar requiere destino >= origen"

5. **¿analyze_clone como comando separado?**: 
   La UI debería mostrar el análisis ANTES de que el usuario presione "Iniciar".
   Necesita un comando Rust que NO clone, solo analice y devuelva los números.

---

# Orden de implementación cuando se decida proceder

```
1. Agregar SetFilePointerEx y FSCTL_GET_VOLUME_BITMAP a disk_win mod
2. Implementar get_volume_bitmap(letter) → VolumeBitmap
3. Implementar last_used_cluster(bitmap) → u64
4. Implementar analyze_clone command (solo análisis, sin copiar)
5. Actualizar CloneDisk.jsx para mostrar análisis en tiempo real
6. Implementar copy_sparse()
7. Implementar patch_boot_sector()
8. Modificar clone_disk_blocking para elegir modo según origen/destino
9. Manejar múltiples particiones
10. Manejar GPT (CRC32 del backup header)
11. Tests con discos reales
```
