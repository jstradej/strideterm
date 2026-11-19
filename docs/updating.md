# Update strIDEterm

## Install an update

1. Open **Settings → About** in the desktop app you want to update. If the sidebar shows an update for a supported installation, clicking it opens the same page.
2. Choose **Check for and download updates** or **Download update**. strIDEterm shows the download progress while you work.
3. When the update is ready, choose **Restart and install**. If strIDEterm asks for confirmation, finish any work you want to keep running first. **Keep working** cancels the restart and leaves the update ready for later in the same session.
4. Check **Settings → About** after the app reopens to see the installed version.

## Choose the update method for your installation

In-app updates start with the first stable release that includes the updater for your package. Install that release once using the package for your platform. [GitHub Releases](https://github.com/jstradej/strideterm/releases/latest)

| Installation                                                                   | Update method                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed Windows installer                                                       | Use **Settings → About**. The new version installs over the current copy.                                                                                                 |
| Signed and notarized macOS app                                                 | Use **Settings → About**. For the first installation, drag the app from the DMG to **Applications**. The updater chooses the package for Intel or Apple Silicon.          |
| Linux x64 AppImage                                                             | Use **Settings → About**. Keep the AppImage in a writable folder such as `~/Applications`. The updater replaces the file at its existing path, so launchers keep working. |
| Microsoft Store or Snap Store                                                  | Use the store's update mechanism.                                                                                                                                         |
| Sideloaded Snap                                                                | Install a newer `.snap` from the source you used to get it.                                                                                                               |
| Windows portable, standalone `.deb`, nightlies, and older or unsigned releases | Download the matching package from [GitHub Releases](https://github.com/jstradej/strideterm/releases) and install it manually.                                            |

## What happens in the background

On launch, GitHub builds check for stable releases and can reuse the result for up to 24 hours. The sidebar can show that a version is available. When you click the download button, the app checks GitHub again and downloads the update for your installed package. It checks the file against the release checksum. Windows also checks the installer's publisher, and macOS checks the new app's signature before restarting.

**Restart and install** saves window and workspace state and stops running terminals and tasks before the app reopens. Your saved configuration is stored separately from the application. Save any unsaved work in terminal programs before restarting.

If the app reports a failure, choose **Try again** when available or **Download from GitHub** to install the matching release manually. On Linux, if an AppImage is in a read-only folder, move it to a writable folder and launch it from there before retrying.
