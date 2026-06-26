/**
 * Stealth Manager Module
 * Handles window stealth features: hide from taskbar, Alt-Tab, and screen sharing
 */

class StealthManager {
  constructor(mainWindow, fileLogger = null) {
    this.mainWindow = mainWindow;
    this.fileLogger = fileLogger;
    this.stealthAddon = null;
    this.stealthInstance = null;
    this.isStealthEnabled = false;

    // Try to load native addon
    this.loadNativeAddon();
  }

  /**
   * Load native stealth addon
   */
  loadNativeAddon() {
    try {
      const path = require('path');
      const { app } = require('electron');

      // Determine the correct path for the native addon
      let addonPath;

      if (app.isPackaged) {
        // In production (packaged app), the native addon is unpacked from ASAR
        addonPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'stealth', 'build', 'Release', 'stealth.node');
      } else {
        // In development
        addonPath = path.join(__dirname, '../../native/stealth/build/Release/stealth.node');
      }

      console.log("🔍 Attempting to load stealth addon from:", addonPath);

      // Try to load the compiled addon
      this.stealthAddon = require(addonPath);
      this.stealthInstance = new this.stealthAddon.StealthMode();
      console.log("✅ Native stealth addon loaded successfully");
      if (this.fileLogger) this.fileLogger.log('debug', 'STEALTH_ADDON_LOADED', { addonPath }, 'success');
    } catch (error) {
      console.warn("⚠️ Native stealth addon not available:", error.message);
      console.warn("Screen sharing stealth will not be available");
      if (this.fileLogger) this.fileLogger.log('debug', 'STEALTH_ADDON_UNAVAILABLE', { error: error.message }, 'warn');
    }
  }

  /**
   * Enable full stealth mode
   * - Hide from taskbar
   * - Hide from Alt-Tab
   * - Hide from screen sharing (if native addon available)
   */
  async enableStealth() {
    if (!this.mainWindow) {
      console.error("No main window available");
      return { success: false, error: "No main window" };
    }

    try {
      // Hide from taskbar
      this.mainWindow.setSkipTaskbar(true);
      console.log("✅ Hidden from taskbar");

      // Remove from Alt-Tab switcher (Windows only)
      if (process.platform === 'win32') {
        // Use WS_EX_TOOLWINDOW style to hide from Alt-Tab
        const nativeWindowHandle = this.mainWindow.getNativeWindowHandle();

        // Hide from screen sharing using native addon
        if (this.stealthInstance && nativeWindowHandle) {
          try {
            const hwnd = nativeWindowHandle.readBigInt64LE(0);
            this.stealthInstance.enableStealthMode(hwnd);
            console.log("✅ Hidden from screen sharing");
          } catch (error) {
            console.warn("⚠️ Screen sharing stealth failed:", error.message);
          }
        }
      }

      this.isStealthEnabled = true;
      if (this.fileLogger) this.fileLogger.log('debug', 'STEALTH_ENABLED', { taskbar: true, altTab: process.platform === 'win32', screenSharing: this.stealthInstance !== null }, 'success');

      return {
        success: true,
        message: "Stealth mode enabled",
        features: {
          taskbar: true,
          altTab: process.platform === 'win32',
          screenSharing: this.stealthInstance !== null
        }
      };
    } catch (error) {
      console.error("Error enabling stealth:", error);
      if (this.fileLogger) this.fileLogger.log('error', 'STEALTH_ENABLE_ERROR', { error: error.message }, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Disable stealth mode
   */
  async disableStealth() {
    if (!this.mainWindow) {
      return { success: false, error: "No main window" };
    }

    try {
      // Show in taskbar
      this.mainWindow.setSkipTaskbar(false);
      console.log("✅ Visible in taskbar");

      // Re-enable screen sharing
      if (this.stealthInstance && process.platform === 'win32') {
        try {
          const nativeWindowHandle = this.mainWindow.getNativeWindowHandle();
          const hwnd = nativeWindowHandle.readBigInt64LE(0);
          this.stealthInstance.disableStealthMode(hwnd);
          console.log("✅ Visible in screen sharing");
        } catch (error) {
          console.warn("⚠️ Failed to disable screen sharing stealth:", error.message);
        }
      }

      this.isStealthEnabled = false;
      if (this.fileLogger) this.fileLogger.log('debug', 'STEALTH_DISABLED', {}, 'success');

      return {
        success: true,
        message: "Stealth mode disabled"
      };
    } catch (error) {
      console.error("Error disabling stealth:", error);
      if (this.fileLogger) this.fileLogger.log('error', 'STEALTH_DISABLE_ERROR', { error: error.message }, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Toggle stealth mode
   */
  async toggleStealth(enabled) {
    if (enabled) {
      return await this.enableStealth();
    } else {
      return await this.disableStealth();
    }
  }

  /**
   * Get stealth status
   */
  getStatus() {
    return {
      enabled: this.isStealthEnabled,
      nativeAddonAvailable: this.stealthInstance !== null,
      platform: process.platform
    };
  }
}

module.exports = StealthManager;
