on run
    set resourcePath to (POSIX path of (path to me)) & "Contents/Resources/"
    try
        do shell script "/bin/zsh " & quoted form of (resourcePath & "bootstrap-installer.zsh") & " " & quoted form of (resourcePath & "payload") & " user"
    on error errorMessage number errorNumber
        if errorNumber is not -128 then
            display dialog errorMessage with title "额度卡片更新助手安装器" buttons {"关闭"} default button "关闭"
        end if
    end try
end run
