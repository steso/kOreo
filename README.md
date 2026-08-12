# kOreo

Browser-based Siemens UTE trajectory extractor. Drop a TWIX `.dat` file to parse its measurement parameters, compute nominal or GIRF-corrected 3D radial trajectories, and export MATLAB, NumPy, scanner protocol, or JSON files.

## Privacy

Processing occurs locally in the browser. TWIX files and generated trajectories are not uploaded.

## GIRF files

Proprietary scanner GIRF calibration files are intentionally **not included** in this public repository or its history. To use GIRF correction, select a local `sp2dGIRF_*.dat` file or folder in the application. The browser stores selected GIRFs in same-origin IndexedDB for future sessions.

## Run locally

Serve this directory with any static web server, then open `index.html`. For example:

```powershell
python -m http.server 8000
```

No build step or third-party runtime dependency is required.

## Security note

The `.pro` export contains the complete scanner protocol and sequence parameters. Treat exported protocol files as confidential and do not publish them without review.
