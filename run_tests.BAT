::===============================================================
:: Run Rigbox tests
::
::   2021-01 MW created
::=============================================================== 
@ECHO OFF
:: Check parameters (id, repo_path, logdir)
IF %1.==. (GOTO Err1)
IF %2.==. (GOTO Err2)
IF %3.==. (GOTO Err3)

:: Run tests
matlab -r runAllTests('%1','%2','%3');exit -wait -log -nosplash -logfile matlab_tests.log
:: Copy over log
SET short=%1
SET log_file=%3\reports\%1\std_output-%short:~0,7%.log
TYPE matlab_tests.log >> %log_file%
MOVE matlab_tests.log %3\reports\%1\test_output.log
:: Kill Alyx login windows in edge
taskkill /FI "IMAGENAME eq msedge.exe" /FI "Windowtitle eq Log in | Alyx*"

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
