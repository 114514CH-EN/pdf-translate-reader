@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist .venv (
    python -m venv .venv
    .venv\Scripts\python.exe -m pip install -q -r backend\requirements.txt
)
if not exist frontend\dist (
    pushd frontend
    if not exist node_modules\@fontsource\inter call npm install
    call npm run build
    popd
)
echo Starting PDF Translate Reader at http://127.0.0.1:8765 ...
.venv\Scripts\python.exe launcher.py
if errorlevel 1 (
    echo.
    echo 服务异常退出，请把上面的错误信息截图发给我。
    pause
)
