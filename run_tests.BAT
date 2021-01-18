::===============================================================
:: Run Rigbox tests
::
::   2021-01 MW created
::=============================================================== 
@ECHO OFF
:: Check parameters (repo, id, logdir)
IF %1.==. (GOTO Err1)
IF %2.==. (GOTO Err2)
IF %3.==. (GOTO Err3)

:: Run tests
:: matlab -r runAllTests('%1','%2','%3');exit -wait -log -nosplash -logfile %3\reports\%2\matlab_tests-%2.log
::matlab -r runAllTests('%1','%2','%3');exit -wait -log -nosplash -logfile matlab_tests.log
:: Copy over log
SET short=%2
type matlab_tests.log >> %3\reports\%2\std_output-%short:~0,7%.log
:: Kill Alyx login windows in edge
::taskkill /FI "IMAGENAME eq msedge.exe" /FI "Windowtitle eq Log in | Alyx*"

EXIT /B %ERRORLEVEL%

:Err1
   ECHO No SHA param defined 1>&2
   EXIT /B 1

:Err2
   ECHO No PATH param defined 1>&2
   EXIT /B 1

:Err3
   ECHO No LOG param defined 1>&2
   EXIT /B 1
