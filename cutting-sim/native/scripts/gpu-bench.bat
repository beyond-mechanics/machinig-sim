@echo off
rem GPU prototype benchmark of the cutting simulator (see native/README.md).
rem Times the two pair passes of a step on the CPU and on the GPU and compares the results.
cd /d "%~dp0"
echo Running the GPU benchmark (drill and 3D end mill examples), about a minute...
sphgpu.exe drill.json --warm 100 --iters 20 > gpu-bench-result.txt 2>&1
sphgpu.exe helix.json --warm 300 --iters 20 >> gpu-bench-result.txt 2>&1
type gpu-bench-result.txt
echo.
echo The result is saved in gpu-bench-result.txt next to this file.
pause
