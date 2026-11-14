!macro customFinishPage
  Function StartDuoCup
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  Function InstallObsStudio
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\duo-cup\obs-install.ps1"' $0
    ${if} $0 != 0
      MessageBox MB_ICONINFORMATION|MB_OK "Установка OBS Studio не завершилась. Её можно запустить из приложения DUO CUP."
    ${endif}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Открыть DUO CUP Комментатор"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartDuoCup"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Скачать и установить OBS Studio, если его ещё нет"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "InstallObsStudio"
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !insertmacro MUI_PAGE_FINISH
!macroend
