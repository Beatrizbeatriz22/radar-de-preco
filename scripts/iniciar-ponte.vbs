' Liga a ponte do Radar escondida (sem janela preta). Usado na inicialização do Windows.
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = pasta
If Not fso.FolderExists(pasta & "\dados") Then fso.CreateFolder(pasta & "\dados")
sh.Run "cmd /c node src\ponte.js >> dados\ponte.log 2>&1", 0, False
