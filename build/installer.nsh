; ============================================================
; NSIS 自定义脚本（electron-builder include）
; 用途：卸载时清理本应用自身的数据（严格限定自身范围，不触碰用户其他数据）
;   - 右键菜单注册表键（本应用注册的）
;   - %TEMP% 下本应用的日志文件
;   - %TEMP% 下本应用创建的临时目录（只匹配本应用实际使用的前缀）
; 说明：安装目录删除/卸载程序注册表项/快捷方式由 electron-builder
;       生成的安装器自动处理，无需在此重复
;
; 注意：
; 1) 卸载段调用的函数必须用 "un." 前缀命名（NSIS 强制要求）
; 2) 独立的 un. 函数必须用 !ifdef BUILD_UNINSTALLER 守卫：
;    否则安装器编译通道会报 warning 6020（有卸载代码但没用 WriteUninstaller），
;    而 electron-builder 把警告当错误处理导致构建失败（实测踩坑）
; ============================================================

; 卸载时执行：清理自身残留
!macro customUnInstall
  ; 1) 删除本应用注册的右键菜单（仅本应用自己的键）
  DeleteRegKey HKCU "Software\Classes\*\shell\LuRenFileConverter"

  ; 2) 清理 %TEMP% 下本应用的日志文件（本应用固定文件名）
  Delete "$TEMP\luren-fileconverter.log"

  ; 3) 清理 %TEMP% 下本应用创建的临时目录
  ;    只匹配本应用 createTempDir 实际使用的前缀（utils/file.js 与各转换器），
  ;    避免误删用户任何其他文件（用户要求：只操作自身数据）
  StrCpy $0 "$TEMP\luren-convert-*"
  Call un.CleanTemp
  StrCpy $0 "$TEMP\luren-img-*"
  Call un.CleanTemp
  StrCpy $0 "$TEMP\luren-bmp-*"
  Call un.CleanTemp
  StrCpy $0 "$TEMP\luren-doc-*"
  Call un.CleanTemp
  StrCpy $0 "$TEMP\luren-ocr-*"
  Call un.CleanTemp
  StrCpy $0 "$TEMP\luren-scan-*"
  Call un.CleanTemp
  StrCpy $0 "$TEMP\luren-preview-*"
  Call un.CleanTemp
!macroend

; 清理单个通配符模式（$0 为模式串；目录整体删，文件直接删）
!ifdef BUILD_UNINSTALLER
Function un.CleanTemp
  FindFirst $1 $2 $0
  IntCmp $1 0 CleanReturn
  CleanLoop:
    IfFileExists "$TEMP\$2\*.*" 0 CleanFile
      RMDir /r "$TEMP\$2"
      Goto CleanNext
    CleanFile:
      Delete "$TEMP\$2"
    CleanNext:
      FindNext $1 $2
      StrCmp $2 "" CleanDone
      Goto CleanLoop
  CleanDone:
    FindClose $1
  CleanReturn:
FunctionEnd
!endif
