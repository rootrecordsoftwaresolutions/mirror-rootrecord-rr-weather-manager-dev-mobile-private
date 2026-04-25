; Default install location for new installs (electron-builder NSIS).
; https://www.electron.build/nsis — "How do change the default installation directory to custom"
;
; Target: 64-bit Program Files\RootRecord\Weather Manager (expandable so non-English "Program Files" works).
; Only seed InstallLocation when none exists yet so upgrades keep the user's existing path
; (same appId / registry key) and replace older binaries in place.

!macro preInit
  SetRegView 64
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" rrwm_chk64cu rrwm_done64
  rrwm_chk64cu:
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" rrwm_wr64 rrwm_done64
  rrwm_wr64:
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\RootRecord\Weather Manager"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\RootRecord\Weather Manager"
  rrwm_done64:
  SetRegView 32
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" rrwm_chk32cu rrwm_done32
  rrwm_chk32cu:
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" rrwm_wr32 rrwm_done32
  rrwm_wr32:
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\RootRecord\Weather Manager"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\RootRecord\Weather Manager"
  rrwm_done32:
!macroend

; Runs after electron-builder's addDesktopLink / addStartMenuLink (see installSection.nsh).
; Default shortcuts use "$appExe" as the icon source; Windows sometimes shows the generic Electron icon
; for index 0. Re-bind shortcuts to the same .ico shipped in resources (matches BrowserWindow branding).
!macro customInstall
  IfFileExists "$INSTDIR\resources\app-icon.ico" rrwm_shortcut_icons rrwm_shortcut_icons_done
  rrwm_shortcut_icons:
  IfFileExists "$newDesktopLink" 0 rrwm_shortcut_no_desktop
    CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\app-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  rrwm_shortcut_no_desktop:
  IfFileExists "$newStartMenuLink" 0 rrwm_shortcut_icons_done
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\app-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  rrwm_shortcut_icons_done:
!macroend
