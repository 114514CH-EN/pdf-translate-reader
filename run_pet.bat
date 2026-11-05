@echo off
chcp 65001 >nul
cd /d %~dp0
REM 桌宠版：同一个后端、同一份 data，只是界面换成会走动的小页。
REM 主版本（run.bat）照旧可用，两个版本互不影响。
if not exist .venv (
    python -m venv .venv
    .venv\Scripts\python.exe -m pip install -q -r backend\requirements.txt
)
if not exist frontend\dist\pet.html (
    pushd frontend
    if not exist node_modules\@fontsource\inter call npm install
    call npm run build
    popd
)
echo Starting PDF Translate Reader 桌宠版 at http://127.0.0.1:8765/pet ...
.venv\Scripts\python.exe launcher.py --pet
if errorlevel 1 (
    echo.
    echo 服务异常退出，请把上面的错误信息截图发给我。
    pause
)
