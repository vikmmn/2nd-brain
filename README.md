# 2nd Brain Notes

A small installable web app for reading and editing an Obsidian vault kept in Google Drive,
from a phone, tablet or laptop. Notes are read from and saved straight back into Google Drive
(the same file, edited in place). Nothing from the vault is stored on the device.

- Opens at the vault (03. Readables › Vik Vault 20220114) (change in `config.js`, or with "Open the app in this folder from now on").
- Read and Edit modes, autosave 1.5 s after typing stops, and a warning instead of overwriting if
  the note changed on another device.
- Shows embedded images, PDFs, video, audio, Excalidraw drawings and embedded notes.
- Updates only when you tap **Update now**.

## Files
| File | What it is |
|---|---|
| `index.html` | The page and its look |
| `app.js` | Everything the app does |
| `drive.js` | Google sign-in and Google Drive (plus a demo vault for trying it out) |
| `config.js` | Settings: the Google sign-in key, home folder, version number |
| `sw.js` | Makes it installable and holds updates until approved |
| `manifest.webmanifest`, `*.png` | App name and icons |
| `demo-data.js` | Pretend files for demo mode only |

## Releasing an approved update
1. Change `VERSION` in both `config.js` and `sw.js` (e.g. 1.0.0 → 1.0.1).
2. Upload the changed files to the GitHub repository.
3. Open the app, tap **Check for update**, then **Update now**.

## Setup (once)
See the steps Claude gives in chat: create a Google Cloud sign-in key (OAuth client ID, type
"Web application", authorised origin = the GitHub Pages address), paste it into `config.js`,
and publish this folder with GitHub Pages.
