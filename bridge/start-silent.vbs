Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
shell.CurrentDirectory = projectDir
' Launch local Sonos bridge completely hidden (window style 0)
shell.Run "node """ & projectDir & "\bridge\server.js""", 0, False
