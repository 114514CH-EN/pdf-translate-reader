@echo off
chcp 65001 >nul
cd /d %~dp0
REM 打包为 dist\PDFTranslate\PDFTranslate.exe （需要 Python 3.10+ 和 Node.js）
if not exist .venv (
    python -m venv .venv
)
.venv\Scripts\python.exe -m pip install -q -r backend\requirements.txt pyinstaller
if errorlevel 1 goto :fail
pushd frontend
if not exist node_modules\@fontsource\inter call npm install
call npm run build
if errorlevel 1 (popd & goto :fail)
popd
.venv\Scripts\pyinstaller.exe --noconfirm --clean --name PDFTranslate --onedir --console ^
  --add-data "frontend\dist;frontend\dist" ^
  --add-data "backend\app\schema.sql;backend\app" ^
  --collect-submodules uvicorn --collect-all pymupdf ^
  --hidden-import backend.app.main --exclude-module pkg_resources ^
  launcher.py
if errorlevel 1 goto :fail
REM 把现有数据（文档/译文/设置）复制到 exe 旁边，exe 版直接接着用
if exist data xcopy /E /I /Y /Q data dist\PDFTranslate\data >nul
echo.
echo 完成：dist\PDFTranslate\PDFTranslate.exe
echo 整个 dist\PDFTranslate 文件夹可以复制到任意位置使用。
pause
exit /b 0
:fail
echo 打包失败，请查看上面的错误信息。
pause
exit /b 1
