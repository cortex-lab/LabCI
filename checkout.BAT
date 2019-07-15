::===============================================================
:: Checkout Rigbox to provided commit
::
::   2019-06 MW created
::=============================================================== 
@ECHO OFF
:: Check parameters
IF %1.==. (GOTO Err1)
IF %2.==. (GOTO Err2)

PUSHD %2
git fetch -a
git reset --hard HEAD
git checkout %1
git submodule update --init --recursive
git submodule foreach git reset --hard HEAD
:: git pull --recurse-submodules --strategy-option=theirs
:: ECHO Checked out %1
:: git status
POPD
EXIT /B %ERRORLEVEL%

:Err1
   ECHO No SHA param defined 1>&2
   EXIT /B 1

:Err2
   ECHO No PATH param defined 1>&2
   EXIT /B 1
