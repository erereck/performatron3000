Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = Chr(34) & base & "\performatron-companion.exe" & Chr(34)
shell.Run exe, 0, False
