fn main() {
    let attrs = tauri_build::Attributes::new();

    // La app corre SIN administrador (asInvoker), en debug y en release.
    // Motivo: Windows bloquea arrastrar archivos desde el Explorador hacia ventanas elevadas.
    // Lo que necesita admin (clonar discos, modo /B) relanza la app elevada bajo demanda
    // (ver `relaunch_as_admin` en lib.rs).
    // Common Controls v6 es necesario para que no falle TaskDialog.
    #[cfg(target_os = "windows")]
    let attrs = attrs.windows_attributes(
        tauri_build::WindowsAttributes::new().app_manifest(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>"#,
        ),
    );

    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
