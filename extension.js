// extension.js - Horizontal Battery Indicator for GNOME Shell 46+ - Fixed Bluetooth Detection
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import UPowerGlib from 'gi://UPowerGlib';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const HorizontalBatteryIndicator = GObject.registerClass(
class HorizontalBatteryIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Horizontal Battery Indicator');

        this._buildUI();
        this._buildPopupMenu();
        this._upowerClient = UPowerGlib.Client.new();

        // Theme detection setup (MUST be before Bluetooth setup)
        this._settings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        this._themeChangedId = this._settings.connect('changed::gtk-theme', () => {
            this._updateTheme();
        });
        this._colorSchemeChangedId = this._settings.connect('changed::color-scheme', () => {
            this._updateTheme();
        });
        this._updateTheme(); // Initial theme setup

        // Bluetooth setup
        this._bluetoothDevices = new Map();
        this._bluetoothMethod = null;
        this._bluetoothUnavailable = false;
        this._initBluetoothMonitoring();

        // Battery status tracking for Ubuntu-style behavior
        this._lastState = null;
        this._statusStartTime = null;
        this._statusShowingTime = false;

        this._updateBatteryInfo();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._updateBatteryInfo();
            return GLib.SOURCE_CONTINUE;
        });

        this._deviceAddedId = this._upowerClient.connect('device-added', () => this._updateBatteryInfo());
        this._deviceRemovedId = this._upowerClient.connect('device-removed', () => this._updateBatteryInfo());
    }

    _initBluetoothMonitoring() {
        console.log('Starting Bluetooth monitoring initialization...');
        
        // Try D-Bus method first, fallback to CLI if it fails
        this._tryDBusBluetoothConnection().catch((error) => {
            console.log('D-Bus method failed, trying CLI fallback:', error.message);
            this._useCliBluetoothMethod();
        });
    }

    async _tryDBusBluetoothConnection() {
        try {
            const connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            console.log('System bus connection established');
            
            // Check if org.bluez service exists (using sync for service check)
            try {
                const nameOwner = connection.call_sync(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'GetNameOwner',
                    GLib.Variant.new('(s)', ['org.bluez']),
                    null,
                    Gio.DBusCallFlags.NONE,
                    1000,
                    null
                );
                
                if (!nameOwner) {
                    throw new Error('org.bluez service not found');
                }
                
                console.log('BlueZ service found, owner:', nameOwner.get_child_value(0).get_string()[0]);
                
            } catch (serviceError) {
                console.error('BlueZ service check failed:', serviceError.message);
                throw serviceError;
            }
            
            // Create the ObjectManager proxy
            this._bluezProxy = new Gio.DBusProxy({
                g_connection: connection,
                g_name: 'org.bluez',
                g_object_path: '/org/bluez',
                g_interface_name: 'org.freedesktop.DBus.ObjectManager',
                g_flags: Gio.DBusProxyFlags.NONE
            });
            
            // Initialize the proxy synchronously for now to ensure it works
            this._bluezProxy.init(null);
            console.log('BlueZ ObjectManager proxy created successfully');
            
            // Test the proxy with a sync call first
            await this._testBluetoothConnection();
            
        } catch (error) {
            console.error('D-Bus connection failed:', error.message);
            throw error;
        }
    }

    async _testBluetoothConnection() {
        try {
            console.log('Testing Bluetooth connection...');
            
            // Use sync call for initial test to ensure it works
            const result = this._bluezProxy.call_sync(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                5000, // 5 second timeout
                null
            );
            
            console.log('Bluetooth connection test successful');
            
            // Connection works, proceed with setup
            this._bluetoothMethod = 'dbus';
            this._bluetoothUnavailable = false;
            this._setupBluetoothMonitoring();
            
        } catch (testError) {
            console.error('Bluetooth connection test failed:', testError.message);
            throw testError;
        }
    }

    _setupBluetoothMonitoring() {
        // Get initial devices
        this._updateBluetoothDevices();
        
        // Monitor for device changes
        try {
            this._bluezSignalId = this._bluezProxy.connectSignal(
                'InterfacesAdded',
                (proxy, sender, [path, interfaces]) => {
                    console.log('Device added:', path);
                    if (interfaces['org.bluez.Device1'] && interfaces['org.bluez.Battery1']) {
                        this._updateBluetoothDevices();
                    }
                }
            );
            
            this._bluezProxy.connectSignal(
                'InterfacesRemoved',
                (proxy, sender, [path, interfaces]) => {
                    console.log('Device removed:', path);
                    this._updateBluetoothDevices();
                }
            );
            
            console.log('Bluetooth signal monitoring setup complete');
            
        } catch (signalError) {
            console.error('Failed to setup Bluetooth signals:', signalError.message);
            // Continue without signal monitoring - polling will still work
        }
        
        // Setup periodic updates
        this._bluetoothTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._updateBluetoothDevices();
            return GLib.SOURCE_CONTINUE;
        });
        
        console.log('Bluetooth monitoring fully initialized');
    }

    _useCliBluetoothMethod() {
        this._bluetoothMethod = 'cli';
        this._bluetoothUnavailable = false;
        console.log('Using CLI method for Bluetooth');
        this._updateBluetoothDevicesCLI();
        
        // Setup periodic updates
        this._bluetoothTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._updateBluetoothDevicesCLI();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateBluetoothDevices() {
        if (this._bluetoothUnavailable || !this._bluezProxy) {
            return;
        }
        
        try {
            console.log('Updating Bluetooth devices via D-Bus...');
            
            // Use sync call to avoid Promise issues
            const result = this._bluezProxy.call_sync(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                5000,
                null
            );
            
            if (!result) {
                console.error('GetManagedObjects returned null');
                return;
            }
            
            const [objects] = result.get_child_value(0).unpack();
            this._bluetoothDevices.clear();
            
            let foundDevices = 0;
            
            Object.keys(objects).forEach(objectPath => {
                const interfaces = objects[objectPath];
                
                // Must have both Device1 and Battery1 interfaces
                if (!('org.bluez.Device1' in interfaces) || !('org.bluez.Battery1' in interfaces)) {
                    return;
                }
                
                const device = interfaces['org.bluez.Device1'];
                const battery = interfaces['org.bluez.Battery1'];
                
                // Must be connected
                if (!device.Connected || !device.Connected.get_boolean()) {
                    return;
                }
                
                const name = device.Alias ? device.Alias.get_string()[0] : 'Unknown Device';
                const percentage = battery.Percentage ? battery.Percentage.get_byte() : 0;
                const deviceType = this._getDeviceType(device);
                
                this._bluetoothDevices.set(objectPath, {
                    name: name,
                    percentage: percentage,
                    type: deviceType,
                    connected: true
                });
                
                foundDevices++;
                console.log(`Found device: ${name} (${percentage}%) - Type: ${deviceType}`);
            });
            
            console.log(`Total devices with battery found: ${foundDevices}`);
            this._updateBluetoothMenuItems();
            
        } catch (e) {
            console.error('Error updating Bluetooth devices:', e.message);
            // Don't mark as unavailable - might be a temporary issue
        }
    }

    _updateBluetoothDevicesCLI() {
        try {
            console.log('Updating Bluetooth devices via CLI...');
            this._bluetoothDevices.clear();
            
            // Get list of devices
            const [success, output] = GLib.spawn_command_line_sync('bluetoothctl devices');
            
            if (!success) {
                throw new Error('bluetoothctl command failed');
            }
            
            const devices = new TextDecoder().decode(output).split('\n');
            let foundDevices = 0;
            
            for (const line of devices) {
                if (!line.startsWith('Device ')) continue;
                
                const parts = line.split(' ');
                if (parts.length < 3) continue;
                
                const deviceAddress = parts[1];
                const deviceName = parts.slice(2).join(' ');
                
                // Check if device is connected and get battery info
                if (this._checkDeviceStatusCLI(deviceAddress, deviceName)) {
                    foundDevices++;
                }
            }
            
            console.log(`Total CLI devices with battery found: ${foundDevices}`);
            this._updateBluetoothMenuItems();
            
        } catch (e) {
            console.error('CLI Bluetooth update failed:', e.message);
            this._bluetoothUnavailable = true;
            this._updateBluetoothMenuItems();
        }
    }

    _checkDeviceStatusCLI(address, name) {
        try {
            const devicePath = address.replace(/:/g, '_');
            
            // Check if device is connected
            const [connSuccess, connOutput] = GLib.spawn_command_line_sync(
                `busctl get-property org.bluez /org/bluez/hci0/dev_${devicePath} org.bluez.Device1 Connected`
            );
            
            if (!connSuccess) return false;
            
            const connectedStatus = new TextDecoder().decode(connOutput).trim();
            if (!connectedStatus.includes('true')) return false;
            
            // Try to get battery level
            const [battSuccess, battOutput] = GLib.spawn_command_line_sync(
                `busctl get-property org.bluez /org/bluez/hci0/dev_${devicePath} org.bluez.Battery1 Percentage`
            );
            
            if (!battSuccess) return false;
            
            const batteryText = new TextDecoder().decode(battOutput).trim();
            const batteryMatch = batteryText.match(/\d+/);
            
            if (!batteryMatch) return false;
            
            const percentage = parseInt(batteryMatch[0]);
            
            // Get additional device properties for better type detection
            let deviceIcon = '';
            let deviceClass = 0;
            
            // Try to get icon property
            try {
                const [iconSuccess, iconOutput] = GLib.spawn_command_line_sync(
                    `busctl get-property org.bluez /org/bluez/hci0/dev_${devicePath} org.bluez.Device1 Icon`
                );
                if (iconSuccess) {
                    const iconText = new TextDecoder().decode(iconOutput).trim();
                    const iconMatch = iconText.match(/"([^"]+)"/);
                    if (iconMatch) {
                        deviceIcon = iconMatch[1];
                    }
                }
            } catch (e) {
                console.log('Could not get device icon:', e.message);
            }
            
            // Try to get device class
            try {
                const [classSuccess, classOutput] = GLib.spawn_command_line_sync(
                    `busctl get-property org.bluez /org/bluez/hci0/dev_${devicePath} org.bluez.Device1 Class`
                );
                if (classSuccess) {
                    const classText = new TextDecoder().decode(classOutput).trim();
                    const classMatch = classText.match(/\d+/);
                    if (classMatch) {
                        deviceClass = parseInt(classMatch[0]);
                    }
                }
            } catch (e) {
                console.log('Could not get device class:', e.message);
            }
            
            const deviceType = this._getDeviceTypeEnhanced(name, deviceIcon, deviceClass);
            
            this._bluetoothDevices.set(address, {
                name: name,
                percentage: percentage,
                type: deviceType,
                connected: true
            });
            
            console.log(`Found CLI device: ${name} (${percentage}%) - Icon: ${deviceIcon} - Class: ${deviceClass} - Type: ${deviceType}`);
            return true;
            
        } catch (e) {
            // Device doesn't have battery or other error - skip it
            return false;
        }
    }

    _getDeviceType(device) {
        // Get device properties
        const deviceClass = device.Class ? device.Class.get_uint32() : 0;
        const name = device.Alias ? device.Alias.get_string()[0] : '';
        const icon = device.Icon ? device.Icon.get_string()[0] : '';
        
        console.log(`Device type detection - Name: "${name}", Icon: "${icon}", Class: ${deviceClass}`);
        
        return this._getDeviceTypeEnhanced(name, icon, deviceClass);
    }

    _getDeviceTypeEnhanced(name, icon, deviceClass) {
        // PRIORITY 1: Check name patterns first (more specific matching)
        const nameType = this._getDeviceTypeFromName(name);
        if (nameType !== '🔵') { // If we found a specific type from name
            console.log(`Device type from name "${name}": ${nameType}`);
            return nameType;
        }
        
        // PRIORITY 2: Check icon property 
        const iconType = this._getDeviceTypeFromIcon(icon);
        if (iconType !== '🔵') { // If we found a specific type from icon
            console.log(`Device type from icon "${icon}": ${iconType}`);
            return iconType;
        }
        
        // PRIORITY 3: Check device class as fallback
        const classType = this._getDeviceTypeFromClass(deviceClass);
        console.log(`Device type from class ${deviceClass}: ${classType}`);
        return classType;
    }

    _getDeviceTypeFromName(name) {
        const lowerName = name.toLowerCase();
        
        // Mouse devices
        if (lowerName.includes('mouse'))  return '🖱️';
        
        // Keyboard devices
        if (lowerName.includes('keyboard') || lowerName.includes('keybd')) return '⌨️';
        
        // Audio devices - earbuds/earphones
        if (lowerName.includes('buds') || lowerName.includes('earbuds') || lowerName.includes('pods') || lowerName.includes('earphone')) return 'ᖰ ᖳ';
        
        // Audio devices - headphones/headsets
        if (lowerName.includes('headphone') || lowerName.includes('headset') || 
            lowerName.includes('focus') || lowerName.includes('plt')) return '🎧';
        
        // Audio devices - speakers
        if (lowerName.includes('speaker') || lowerName.includes('jbl') || 
            lowerName.includes('flip') || lowerName.includes('charge')) return '🔊';
        
        // Phone devices - enhanced patterns for phones
        if (lowerName.includes('phone') || 
            lowerName.includes('iphone') || 
            lowerName.includes('samsung') || 
            lowerName.includes('galaxy') || 
            lowerName.includes('huawei') || 
            lowerName.includes('xiaomi') || 
            lowerName.includes('oneplus') || 
            lowerName.includes('pixel') ||
            lowerName.includes('nokia') ||
            lowerName.includes('lg ') ||
            lowerName.includes('sony') ||
            lowerName.includes('motorola') ||
            lowerName.includes('oppo') ||
            lowerName.includes('vivo') ||
            lowerName.includes('realme') ||
            lowerName.match(/\b(p\d+|mate \d+|s\d+|note \d+|pro \d+|max \d+|plus \d+|mini \d+)\b/)) return '📱';
        
        // Watch devices
        if (lowerName.includes('watch')) return '⌚';
        
        // Game controllers
        if (lowerName.includes('controller') || lowerName.includes('xbox') || lowerName.includes('dualshock') || lowerName.includes('dualsense') || lowerName.includes('pro controller')) return '🎮';
        
        // Pen/stylus devices
        if (lowerName.includes('pen') || lowerName.includes('stylus')) return '🖊️';
        
        // Camera devices
        if (lowerName.includes('camera') || lowerName.includes('gopro')) return '📷';
        
        // Tablet devices
        if (lowerName.includes('tablet') || lowerName.includes('ipad')) return '📸';
        
        return '🔵'; // Return generic if no match found
    }

    _getDeviceTypeFromIcon(icon) {
        if (!icon) return '🔵';
        
        const lowerIcon = icon.toLowerCase();
        
        switch (lowerIcon) {
            case 'phone':
            case 'smartphone':
                return '📱';
            case 'audio-headphones':
            case 'headphones':
            case 'headset':
                return '🎧';
            case 'audio-speakers':
            case 'speaker':
                return '🔊';
            case 'input-mouse':
            case 'mouse':
                return '🖱️';
            case 'input-keyboard':
            case 'keyboard':
                return '⌨️';
            case 'camera':
            case 'camera-photo':
                return '📷';
            case 'tablet':
                return '📸';
            case 'watch':
            case 'smartwatch':
                return '⌚';
            case 'gamepad':
            case 'controller':
                return '🎮';
            default:
                return '🔵'; // Return generic if no match found
        }
    }

    _getDeviceTypeFromClass(deviceClass) {
        if (deviceClass === 0) return '🔵';
        
        // Check device class (Bluetooth device class format)
        const majorClass = (deviceClass >> 8) & 0x1f;
        const minorClass = (deviceClass >> 2) & 0x3f;
        
        console.log(`Device class analysis - Major: ${majorClass}, Minor: ${minorClass}, Full: ${deviceClass}`);
        
        // Phone devices (Major class 0x02)
        if (majorClass === 0x02) {
            console.log('Detected phone from device class');
            return '📱';
        }
        
        // Audio devices (Major class 0x04)
        if (majorClass === 0x04) {
            if (minorClass === 0x01 || minorClass === 0x02) return '🎧'; // Headphones/Headset
            if (minorClass === 0x06) return '🔊'; // Speakers
            return '🎧'; // Other audio devices default to headphones
        }
        
        // Input devices (Major class 0x05)
        if (majorClass === 0x05) {
            if (minorClass === 0x40 || minorClass === 0x80) return '⌨️'; // Keyboard
            if (minorClass === 0x20) return '🖱️'; // Mouse
            return '⌨️'; // Other input devices default to keyboard
        }
        
        // Imaging devices (Major class 0x06)
        if (majorClass === 0x06) {
            return '📷';
        }
        
        // Wearable devices (Major class 0x07)
        if (majorClass === 0x07) {
            return '⌚';
        }
        
        // Toy/Game devices (Major class 0x08)
        if (majorClass === 0x08) {
            return '🎮';
        }
        
        console.log(`Unknown device class ${deviceClass}, using generic icon`);
        return '🔵'; // Default generic Bluetooth icon
    }

    _createMiniBatteryIndicator(percentage) {
        // Create mini battery container
        const miniBatteryContainer = new St.BoxLayout({
            style_class: 'mini-battery-container',
            vertical: false,
        });

        // Mini battery outline - MADE LONGER
        const miniBatteryOutline = new St.Bin({
            style_class: 'mini-battery-outline',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Mini fill container
        const miniFillContainer = new St.BoxLayout({
            vertical: false,
            style_class: 'mini-battery-fill-container'
        });

    // Calculate fill width (mini battery is now 42px wide internally, with 2px border = 38px usable)

    const fillWidth = Math.max(1, Math.round((percentage / 100) * 40));
    const emptyWidth = Math.max(0, 40 - fillWidth);

        // Mini colored fill
        const miniBatteryFill = new St.Widget({
            style_class: 'mini-battery-fill',
            width: fillWidth,
            height: 13
        });

        // Mini empty space
        const miniBatteryEmpty = new St.Widget({
            style_class: 'mini-battery-empty',
            width: emptyWidth,
            height: 13
        });

        // Add color class based on percentage
        const fillColor = this._getGradientColor(percentage);
        const colorClass = this._getColorClass(percentage);
        miniBatteryFill.add_style_class_name('mini-' + colorClass);

        // Add fill and empty to container
        miniFillContainer.add_child(miniBatteryFill);
        miniFillContainer.add_child(miniBatteryEmpty);
        miniBatteryOutline.set_child(miniFillContainer);

        // Mini battery tip - ADJUSTED SIZE
        const miniTipInner = new St.Widget({
            style_class: 'mini-battery-tip',
            width: 2,
            height: 8,
        });
        const miniBatteryTip = new St.Bin({
            child: miniTipInner,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Mini percentage label - MADE MORE VISIBLE
        const miniPercentageLabel = new St.Label({
            text: `${Math.round(percentage)}%`,
            style_class: 'mini-battery-percentage',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        miniBatteryOutline.add_child(miniPercentageLabel);

        // Assemble mini battery
        miniBatteryContainer.add_child(miniBatteryOutline);
        miniBatteryContainer.add_child(miniBatteryTip);

        return miniBatteryContainer;
    }

    _updateBluetoothMenuItems() {
        if (!this._bluetoothSection) return;

        console.log('Updating Bluetooth menu items...');
        console.log('Bluetooth unavailable flag:', this._bluetoothUnavailable);
        console.log('Device count:', this._bluetoothDevices.size);

        // Remove all existing bluetooth device items (keep header)
        const items = this._bluetoothSection._getMenuItems();
        for (let i = items.length - 1; i >= 1; i--) { // Skip first item (header)
            items[i].destroy();
        }

        if (this._bluetoothUnavailable) {
            console.log('Showing Bluetooth unavailable message');
            this._bluetoothErrorItem = new PopupMenu.PopupMenuItem(this._toSmallCaps('Bluetooth unavailable'), {
                reactive: false,
                style_class: 'battery-detail-item bluetooth-error'
            });
            this._bluetoothSection.addMenuItem(this._bluetoothErrorItem);
        } else if (this._bluetoothDevices.size === 0) {
            console.log('Showing no devices message');
            this._bluetoothNoDevicesItem = new PopupMenu.PopupMenuItem(this._toSmallCaps('No connected devices with battery info'), {
                reactive: false,
                style_class: 'battery-detail-item'
            });
            this._bluetoothSection.addMenuItem(this._bluetoothNoDevicesItem);
        } else {
            console.log('Adding device items...');
            // Add device items with mini battery indicators
            this._bluetoothDevices.forEach((device, path) => {
                // Create custom menu item with battery indicator
                const deviceItem = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    style_class: 'battery-detail-item bluetooth-device-item'
                });

                // Create horizontal layout for the device item
                const deviceLayout = new St.BoxLayout({
                    vertical: false,
                    style_class: 'bluetooth-device-layout',
                    x_expand: true
                });

                // Create mini battery indicator
                const miniBattery = this._createMiniBatteryIndicator(device.percentage);

                // Device info container
                const deviceInfoLayout = new St.BoxLayout({
                    vertical: false,
                    style_class: 'bluetooth-device-info',
                    x_expand: true
                });

                // Device text
                const deviceText = `${device.type} ${device.name}`;
                const deviceLabel = new St.Label({
                    text: deviceText,
                    style_class: 'bluetooth-device-label',
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true
                });

                // Add components to layout
                deviceInfoLayout.add_child(deviceLabel);
                
                deviceLayout.add_child(miniBattery);
                deviceLayout.add_child(deviceInfoLayout);

                deviceItem.add_child(deviceLayout);

                // Add battery level color coding to the entire item
                const batteryClass = this._getBluetoothBatteryColorClass(device.percentage);
                deviceItem.actor.add_style_class_name(batteryClass);

                this._bluetoothSection.addMenuItem(deviceItem);
                
                console.log('Added menu item with mini battery:', deviceText, device.percentage + '%');
            });
        }

        // Apply theme colors to new items
        this._applyThemeToBluetoothItems(this._isLightTheme());
        
        console.log('Bluetooth menu items updated');
    }

    _getBluetoothBatteryColorClass(percentage) {
        if (percentage <= 15) return 'bluetooth-battery-critical';
        if (percentage <= 30) return 'bluetooth-battery-low';
        if (percentage <= 60) return 'bluetooth-battery-medium';
        return 'bluetooth-battery-high';
    }

    _applyThemeToBluetoothItems(isLightTheme) {
        const textColor = isLightTheme ? 'rgba(0, 0, 0, 0.87)' : 'rgba(255, 255, 255, 0.9)';
        const textShadow = isLightTheme ? '1px 1px 2px rgba(255, 255, 255, 0.6)' : '1px 1px 2px rgba(0, 0, 0, 0.6)';
        
        const itemStyle = `color: ${textColor} !important; text-shadow: ${textShadow} !important; font-size: 10pt !important; font-variant: small-caps !important;`;
        
        // Apply to bluetooth header
        if (this._bluetoothHeaderItem) {
            const headerStyle = `color: ${textColor} !important; text-shadow: ${textShadow} !important; font-size: 12pt !important; font-weight: bold !important; font-variant: small-caps !important;`;
            this._bluetoothHeaderItem.label.style = headerStyle;
        }

        // Apply to all bluetooth device items
        if (this._bluetoothSection) {
            const items = this._bluetoothSection._getMenuItems();
            for (let i = 1; i < items.length; i++) { // Skip header (index 0)
                const item = items[i];
                // Find all labels in the item and apply styling
                const labels = this._findLabelsInActor(item.actor);
                labels.forEach(label => {
                    if (label.style_class && label.style_class.includes('bluetooth-device-label')) {
                        label.style = itemStyle;
                    }
                });
            }
        }
    }

    _findLabelsInActor(actor) {
        const labels = [];
        
        if (actor instanceof St.Label) {
            labels.push(actor);
        }
        
        // Recursively search children
        if (actor.get_children) {
            const children = actor.get_children();
            for (const child of children) {
                labels.push(...this._findLabelsInActor(child));
            }
        }
        
        return labels;
    }

    _updateTheme() {
        try {
            if (!this._settings) {
                console.warn('Settings not available for theme update');
                return;
            }
            
            const gtkTheme = this._settings.get_string('gtk-theme').toLowerCase();
            const colorScheme = this._settings.get_string('color-scheme');
            
            // Enhanced light theme detection for Ubuntu
            const isLightTheme = colorScheme === 'prefer-light' || 
                               gtkTheme.includes('light') || 
                               gtkTheme.includes('default') ||
                               (gtkTheme.includes('yaru') && !gtkTheme.includes('dark')) ||
                               (gtkTheme.includes('adwaita') && !gtkTheme.includes('dark'));
            
            // Remove existing theme classes from POPUP elements only
            if (this.menu && this.menu.actor) {
                this.menu.actor.remove_style_class_name('light-theme');
            }
            if (this._largeBatteryOutline) {
                this._largeBatteryOutline.remove_style_class_name('light-theme');
            }
            
            // Apply light theme class ONLY to popup elements
            if (isLightTheme) {
                if (this.menu && this.menu.actor) {
                    this.menu.actor.add_style_class_name('light-theme');
                }
                if (this._largeBatteryOutline) {
                    this._largeBatteryOutline.add_style_class_name('light-theme');
                }
            }
            
            // Force refresh of menu items with inline styles (popup only)
            this._applyThemeToMenuItems(isLightTheme);
            this._applyThemeToBluetoothItems(isLightTheme);
            this._applyThemeToBatteryDetails(isLightTheme);
            
        } catch (e) {
            console.error('Error updating theme:', e.message);
        }
    }

    _applyThemeToMenuItems(isLightTheme) {
        const textColor = isLightTheme ? 'rgba(0, 0, 0, 0.87)' : 'rgba(255, 255, 255, 0.9)';
        const textShadow = isLightTheme ? '1px 1px 2px rgba(255, 255, 255, 0.6)' : '1px 1px 2px rgba(0, 0, 0, 0.6)';

        
        // Apply hostname styling
        const hostnameStyle = `color: ${textColor} !important; text-shadow: ${textShadow} !important; font-size: 12pt !important; font-weight: bold !important; font-variant: small-caps !important;`;
        if (this._hostnameItem && this._hostnameItem.label) {
            this._hostnameItem.label.style = hostnameStyle;
        }

        // Update large battery text colors with new sizes
         if (this._largeNumberLabel) {
                this._largeNumberLabel.style = `font-size: 22pt !important; font-weight: bold !important; color: ${textColor} !important; text-shadow: ${textShadow} !important;`;
            }
            if (this._largeSymbolLabel) {
                this._largeSymbolLabel.style = `font-size: 12pt !important; color: ${textColor} !important; text-shadow: ${textShadow} !important;`;
            }
            // Single status line styling
            if (this._largeStatusLabel) {
                const statusColor = this._largeStatusLabel.get_text().includes('⚡') ? 
                    (isLightTheme ? '#f2f41f' : '#f2f41f') : textColor;
                this._largeStatusLabel.style = `font-size: 9pt !important; color: ${statusColor} !important;font-weight: bold !important; text-shadow: ${textShadow} !important; text-align: center !important;`;
            }
    }

    _buildUI() {
        this._container = new St.BoxLayout({
            style_class: 'horizontal-battery-container',
            vertical: false,
        });

        // Charging icon (thunder/lightning symbol) - outside battery
        this._chargingIcon = new St.Label({
            text: '⚡',
            style_class: 'battery-charging-icon',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false
        });

        // Outline
        this._batteryOutline = new St.Bin({
            style_class: 'battery-outline',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Fill container - this will hold both the colored fill and empty space
        this._fillContainer = new St.BoxLayout({
            vertical: false,
            style_class: 'battery-fill-container'
        });

        // Colored fill (represents remaining battery)
        this._batteryFill = new St.Widget({
            style_class: 'battery-fill',
            width: 2,
            height: 14
        });

        // Empty space (represents consumed battery)
        this._batteryEmpty = new St.Widget({
            style_class: 'battery-empty',
            height: 14
        });

        // Add fill first (left), then empty space (right)
        this._fillContainer.add_child(this._batteryFill);
        this._fillContainer.add_child(this._batteryEmpty);
        this._batteryOutline.set_child(this._fillContainer);

        // Label overlay - just percentage inside battery
        this._percentageLabel = new St.Label({
            text: '',
            style_class: 'battery-percentage',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._batteryOutline.add_child(this._percentageLabel);

        // Battery tip
        const tipInner = new St.Widget({
            style_class: 'battery-tip',
            width: 2,
            height: 10,
        });
        this._batteryTip = new St.Bin({
            child: tipInner,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Pack - charging icon first (left), then battery outline, then tip
        this._container.add_child(this._chargingIcon);
        this._container.add_child(this._batteryOutline);
        this._container.add_child(this._batteryTip);
        this.add_child(this._container);
    }

    _buildPopupMenu() {
        // Clear existing menu
        this.menu.removeAll();
        
        // Add style class to the entire menu for theme support with larger width
        this.menu.actor.add_style_class_name('horizontal-battery-menu');
        this.menu.actor.style = 'min-width: 280px; max-width: 320px;'; // Increased from 200px

        // Hostname section
        this._hostnameItem = new PopupMenu.PopupMenuItem(this._toSmallCaps(GLib.get_host_name() || 'Unknown Device'), {
            reactive: false,
            style_class: 'battery-hostname'
        });

        // Custom battery visualization section
        this._batteryVisualSection = new PopupMenu.PopupMenuSection();
        this._batteryVisualItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'battery-visual-item'
        });

        // Create large battery visualization
        this._createBatteryVisual();
        this._batteryVisualSection.addMenuItem(this._batteryVisualItem);

        // Bluetooth devices section
        this._bluetoothSection = new PopupMenu.PopupMenuSection();
        this._bluetoothHeaderItem = new PopupMenu.PopupMenuItem(this._toSmallCaps('connected devices'), {
            reactive: false,
            style_class: 'battery-hostname'
        });
        this._bluetoothSection.addMenuItem(this._bluetoothHeaderItem);
        this._bluetoothNoDevicesItem = new PopupMenu.PopupMenuItem(this._toSmallCaps('No devices found'), {
            reactive: false,
            style_class: 'battery-detail-item'
        });
        this._bluetoothSection.addMenuItem(this._bluetoothNoDevicesItem);

        // Add all sections to menu
        this.menu.addMenuItem(this._hostnameItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._batteryVisualSection);
                        // Battery details section
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._batteryDetailsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._batteryDetailsSection);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._bluetoothSection);
                

    }

    _createBatteryVisual() {
        // Main container for the large battery visualization
        this._visualContainer = new St.BoxLayout({
             vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'battery-visual-container',
            x_expand: true  // ADD THIS
        });

        // Large battery outline
        this._largeBatteryContainer = new St.BoxLayout({
            vertical: false,
            style_class: 'large-battery-container',
            x_align: Clutter.ActorAlign.CENTER,  // ADD THIS
            x_expand: true  // ADD THIS
        });

        this._largeBatteryOutline = new St.Bin({
            style_class: 'large-battery-outline',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER
        });

        // Large battery fill container
        this._largeFillContainer = new St.BoxLayout({
            vertical: false,
            style_class: 'large-battery-fill-container'
        });

        // Large colored fill
        this._largeBatteryFill = new St.Widget({
            style_class: 'large-battery-fill',
            width: 4,
            height: 50
        });

        // Large empty space
        this._largeBatteryEmpty = new St.Widget({
            style_class: 'large-battery-empty',
            height: 50
        });

        this._largeFillContainer.add_child(this._largeBatteryFill);
        this._largeFillContainer.add_child(this._largeBatteryEmpty);
        this._largeBatteryOutline.set_child(this._largeFillContainer);

        // Create simplified layout container with only percentage and single status line
        const internalLayout = new St.BoxLayout({
            vertical: true,
            style_class: 'large-battery-content',
            x_align: Clutter.ActorAlign.CENTER,

        });

        // Percentage container at the top
        this._largePercentageContainer = new St.BoxLayout({
            vertical: false,
            style_class: 'large-percentage-container',
            x_align: Clutter.ActorAlign.CENTER,
        });
        
        // Push the number and symbol together
        this._largeNumberLabel = new St.Label({
            text: '', 
            style: 'font-size: 16pt !important; font-weight: bold !important;',
        });
        this._largeSymbolLabel = new St.Label({
            text: '%',
            style: 'font-size: 10pt !important;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._largePercentageContainer.add_child(this._largeNumberLabel);
        this._largePercentageContainer.add_child(this._largeSymbolLabel);

        // Single status line below percentage
        this._largeStatusLabel = new St.Label({
            text: 'Unknown',
            style_class: 'large-battery-status',
            x_align: Clutter.ActorAlign.CENTER,
        });
        
        // Add percentage at top, then single status below
        internalLayout.add_child(this._largePercentageContainer);
        internalLayout.add_child(this._largeStatusLabel);

        this._largeBatteryOutline.add_child(internalLayout);

        // Large battery tip
        const largeTipInner = new St.Widget({
            style_class: 'large-battery-tip',
            width: 4,
            height: 27,
        });
        this._largeBatteryTip = new St.Bin({
            child: largeTipInner,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Assemble large battery
        this._largeBatteryContainer.add_child(this._largeBatteryOutline);
        this._largeBatteryContainer.add_child(this._largeBatteryTip);

        this._visualContainer.add_child(this._largeBatteryContainer);
        this._batteryVisualItem.add_child(this._visualContainer);
    }

    _updateBatteryInfo() {
        try {
            const devices = this._upowerClient.get_devices();
            let battery = devices.find(device => {
                try {
                    let type = typeof device.get_device_type === 'function'
                        ? device.get_device_type()
                        : device.device_type;
                    return type === UPowerGlib.DeviceType.BATTERY;
                } catch (_) {
                    const path = typeof device.get_object_path === 'function'
                        ? device.get_object_path()
                        : device.object_path || '';
                    return path.includes('BAT');
                }
            });

            if (!battery) {
                this._percentageLabel.set_text('N/A');
                this._batteryFill.set_width(2);
                this._batteryEmpty.set_width(40);
                this._chargingIcon.visible = false;

                // Remove color classes
                this._batteryFill.remove_style_class_name('battery-critical');
                this._batteryFill.remove_style_class_name('battery-low');
                this._batteryFill.remove_style_class_name('battery-medium');
                this._batteryFill.remove_style_class_name('battery-high');
                this._batteryFill.add_style_class_name('battery-gray');

                this._batteryFill.remove_style_class_name('charging');
                this._batteryFill.remove_style_class_name('low-battery');
                this._updateMenuItems(null);
                return;
            }

            const percent = this._getValue(battery, 'percentage', 'get_percentage');
            const state = this._getValue(battery, 'state', 'get_state');
            const timeToEmpty = this._getValue(battery, 'time_to_empty', 'get_time_to_empty');
            const timeToFull = this._getValue(battery, 'time_to_full', 'get_time_to_full');
            
                                        // >>> Update Battery Details Section <<<
                            const cycles = this._getValue(battery, 'cycle_count', 'get_cycle_count');
                            const voltage = this._getValue(battery, 'voltage', 'get_voltage') || 0;
                            const rate = this._getValue(battery, 'energy_rate', 'get_energy_rate') || 0;
                            this._updateBatteryDetails(battery);
                                        
            

            const outlineWidth = 46; // must match CSS
            const fillWidth = Math.max(2, Math.round((percent / 100) * (outlineWidth - 4)));
            const emptyWidth = Math.max(0, (outlineWidth - 4) - fillWidth);
            const fillColor = this._getGradientColor(percent);

            // Set the width of the filled part (remaining battery)
            this._batteryFill.set_width(fillWidth);
            // Set the width of the empty part (consumed battery)
            this._batteryEmpty.set_width(emptyWidth);

            // Remove all previous color classes
            this._batteryFill.remove_style_class_name('battery-critical');
            this._batteryFill.remove_style_class_name('battery-low');
            this._batteryFill.remove_style_class_name('battery-medium');
            this._batteryFill.remove_style_class_name('battery-high');
            this._batteryFill.remove_style_class_name('battery-gray');

            // Add appropriate color class
            const colorClass = this._getColorClass(percent);
            this._batteryFill.add_style_class_name(colorClass);

            // Also try inline style as fallback
            this._batteryFill.style = `background-color: ${fillColor} !important;`;

            // Handle charging animation and icon
            if (state === UPowerGlib.DeviceState.CHARGING) {
                this._batteryFill.add_style_class_name('charging');
                this._chargingIcon.visible = true;
                this._chargingIcon.add_style_class_name('charging-pulse');
            } else {
                this._batteryFill.remove_style_class_name('charging');
                this._chargingIcon.visible = false;
                this._chargingIcon.remove_style_class_name('charging-pulse');
            }

            // Handle low battery warning
            if (percent <= 15 && state === UPowerGlib.DeviceState.DISCHARGING) {
                this._batteryFill.add_style_class_name('low-battery');
                this._container.add_style_class_name('low-battery-container');
            } else {
                this._batteryFill.remove_style_class_name('low-battery');
                this._container.remove_style_class_name('low-battery-container');
            }

            // Set percentage with small caps
            this._percentageLabel.set_text(`${Math.round(percent)}%`);
            this._percentageLabel.style = 'font-variant: small-caps;';

            // Update large battery visual in popup with Ubuntu-style behavior
            this._updateLargeBatteryVisual(percent, state, timeToEmpty, timeToFull);

            this._updateMenuItems(battery, percent, state, timeToEmpty, timeToFull);

        } catch (e) {
            console.error('Battery info update failed:', e);
            this._percentageLabel.set_text('Err');
            this._batteryFill.remove_style_class_name('charging');
            this._batteryFill.remove_style_class_name('low-battery');
        }
    }

// bttry detials


_updateBatteryDetails(battery) {
    if (!this._batteryDetailsSection) return;
    this._batteryDetailsSection.removeAll();
    if (!battery) return;
    // If level is missing/unknown, fall back to mapping from percentage
       let level = this._getValue(battery, 'level', 'get_level');

  

    // now you can safely use `level`
    log(`Battery level: ${level}`);
    const state = this._getValue(battery, 'state', 'get_state');
    const design = this._getValue(battery, 'energy-full-design', 'get_energy_full_design') || 0;
    const cycles = this._getValue(battery, 'charge_cycles', 'get_charge_cycles');
    const rate = this._getValue(battery, 'energy_rate', 'get_energy_rate') || 0;
    const voltage = this._getValue(battery, 'voltage', 'get_voltage') || 0;
    const energyFull = this._getValue(battery, 'energy-full', 'get_energy_full') || 0;
 if (!level || level === 'Unknown') {
        const percentage = this._getValue(battery, 'percentage', 'get_percentage');
        level = this._percentageToLevel(percentage);
    }
    const energyNow = this._getValue(battery, 'energy', 'get_energy') || 0; // sometimes 'energy_now'



    // Convert numeric state to human-readable text
    const stateText = this._getStateText(state);
    
    // Handle cycles properly - show actual value or 'Unknown' if unavailable
    const cyclesText = (cycles !== null && cycles !== undefined) ? cycles.toString() : 'Unknown';

    const details = [
        { label: 'state',   value: stateText },
        { label: 'cycles',  value: cyclesText },
        { label: 'voltage', value: `${voltage.toFixed(2)} V` },
        { label: 'rate',    value: `${rate.toFixed(2)} W` },
        // Second column
        { label: 'E. Design', value: `${design.toFixed(2)} Wh` },
        { label: 'E. full', value: `${energyFull.toFixed(2)} Wh` },
        { label: 'E. now', value: `${energyNow.toFixed(2)} Wh` },
        { label: 'level', value: level },
    ];


    // Two-column layout for details
    for (let i = 0; i < details.length; i += 2) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'battery-details-item' });
        let row = new St.BoxLayout({ vertical: false, style_class: 'battery-details-row' });

        // First col: label and value
        row.add_child(new St.Label({ text: this._toSmallCaps(details[i].label), style_class: 'battery-detail-label' }));
        row.add_child(new St.Label({ text: details[i].value, style_class: 'battery-detail-label' }));

        // Second col, if exists
        if (details[i + 1]) {
            // Add a little spacing
            row.add_child(new St.Label({ text: '\u2003' }));
            row.add_child(new St.Label({ text: this._toSmallCaps(details[i + 1].label), style_class: 'battery-detail-label' }));
            row.add_child(new St.Label({ text: details[i + 1].value, style_class: 'battery-detail-label' }));
        }

        item.add_child(row);
        this._batteryDetailsSection.addMenuItem(item);
    }



}


/// define level

    _percentageToLevel(p) {
        if (p == null) return "Unknown";
        if (p === 0) return "None";
        if (p < 20) return "Critical";
        if (p < 40) return "Low";
        if (p < 60) return "Normal";
        if (p < 80) return "High";
        return "Full";
    }

////

_updateLargeBatteryVisual(percent, state, timeToEmpty, timeToFull) {
    const outlineWidth = 220;
    const minFillWidth = percent >= 10 ? 30 : 20;
    const calculatedFillWidth = Math.round((percent / 100) * (outlineWidth - 4));
    const fillWidth = Math.max(minFillWidth, calculatedFillWidth);
    const emptyWidth = Math.max(0, (outlineWidth - 4) - fillWidth);

    this._largeBatteryFill.set_width(fillWidth);
    this._largeBatteryEmpty.set_width(emptyWidth);

    // Use the same gradient color calculation as the small battery
    const fillColor = this._getGradientColor(percent);
    
    // Remove all previous color classes
   /* this._largeBatteryFill.remove_style_class_name('large-battery-critical');
    this._largeBatteryFill.remove_style_class_name('large-battery-low');
    this._largeBatteryFill.remove_style_class_name('large-battery-medium');
    this._largeBatteryFill.remove_style_class_name('large-battery-high');
    */
    // Set the color using inline style to match the gradient
    this._largeBatteryFill.style = `background-color: ${fillColor} !important;`;

    this._largeNumberLabel.set_text(`${Math.round(percent)}`);
    this._largeSymbolLabel.set_text('%');

    // Ubuntu-style single status line behavior
    let statusText = this._getUbuntuStyleStatus(state, timeToEmpty, timeToFull);

    this._largeStatusLabel.set_text(statusText);
    
    // Handle charging animation
    if (state === UPowerGlib.DeviceState.CHARGING) {
        this._largeBatteryFill.add_style_class_name('large-charging');
        this._largeStatusLabel.add_style_class_name('charging-status');
    } else {
        this._largeBatteryFill.remove_style_class_name('large-charging');
        this._largeStatusLabel.remove_style_class_name('charging-status');
    }
    
    this._applyThemeToMenuItems(this._isLightTheme());
}









    
    
    
    
    
    

    _getUbuntuStyleStatus(state, timeToEmpty, timeToFull) {
        // Check if state has changed to reset timer
        if (this._lastState !== state) {
            this._lastState = state;
            this._statusStartTime = GLib.get_monotonic_time();
            this._statusShowingTime = false;
        }

        const currentTime = GLib.get_monotonic_time();
        const elapsedSeconds = (currentTime - this._statusStartTime) / 1000000; // Convert to seconds

        if (state === UPowerGlib.DeviceState.FULL) {
            return 'Fully Charged';
        } else if (state === UPowerGlib.DeviceState.CHARGING) {
            // Show "Charging" for first 3 seconds, then switch to time
            if (elapsedSeconds < 3 && !this._statusShowingTime) {
                return '⚡ Charging';
            } else {
                this._statusShowingTime = true;
                if (timeToFull > 0) {
                    return `⚡ ${this._formatTime(timeToFull)} until full`;
                } else {
                    return '⚡ Charging';
                }
            }
        } else if (state === UPowerGlib.DeviceState.DISCHARGING) {
            // Show "Discharging" for first 3 seconds, then switch to time
            if (elapsedSeconds < 3 && !this._statusShowingTime) {
                return 'Discharging';
            } else {
                this._statusShowingTime = true;
                if (timeToEmpty > 0) {
                    return `${this._formatTime(timeToEmpty)} remaining`;
                } else {
                    return 'Discharging';
                }
            }
        } else {
            return this._getStateText(state);
        }
    }

    _isLightTheme() {
        try {
            if (!this._settings) {
                console.warn('Settings not available, assuming dark theme');
                return false;
            }
            
            const gtkTheme = this._settings.get_string('gtk-theme').toLowerCase();
            const colorScheme = this._settings.get_string('color-scheme');
            
            return colorScheme === 'prefer-light' || 
                   gtkTheme.includes('light') || 
                   gtkTheme.includes('default') ||
                   (gtkTheme.includes('yaru') && !gtkTheme.includes('dark')) ||
                   (gtkTheme.includes('adwaita') && !gtkTheme.includes('dark'));
        } catch (e) {
            console.error('Error checking theme:', e.message);
            return false;
        }
    }

    _updateMenuItems(battery, percent, state, timeToEmpty, timeToFull) {
        if (!battery) {
            this._largeNumberLabel.set_text('N/A');
            this._largeSymbolLabel.set_text('%');
            this._largeStatusLabel.set_text('No Battery Found');
            this._largeBatteryFill.set_width(6);
            this._largeBatteryEmpty.set_width(212);
            this._applyThemeToMenuItems(this._isLightTheme());
            return;
        }

        // Apply theme colors after updating battery visual
        this._applyThemeToMenuItems(this._isLightTheme());
    }

    _toSmallCaps(text) {
        return text.toUpperCase();
    }

    _getValue(device, prop, method) {
        try {
            if (typeof device[method] === 'function') return device[method]();
            if (prop in device) return device[prop];
        } catch (_) {}
        return 0;
    }

    _getStateText(state) {
        switch (state) {
            case UPowerGlib.DeviceState.CHARGING: return 'Charging';
            case UPowerGlib.DeviceState.DISCHARGING: return 'Discharging';
            case UPowerGlib.DeviceState.FULL: return 'Full';
            case UPowerGlib.DeviceState.EMPTY: return 'Empty';
            case UPowerGlib.DeviceState.NOT_CHARGING: return 'Not Charging';
            case UPowerGlib.DeviceState.PENDING_CHARGE: return 'Pending Charge';
            case UPowerGlib.DeviceState.PENDING_DISCHARGE: return 'Pending Discharge';
            default: return 'Unknown';
        }
    }

    _getGradientColor(percent) {
        if (percent <= 0) return '#F44336';
        if (percent >= 100) return '#4CAF50';
        if (percent < 15) return '#F44336';
        if (percent < 30) return this._interpolateColor([244, 67, 54], [255, 152, 0], (percent - 15) / 15);
        if (percent < 60) return this._interpolateColor([255, 152, 0], [255, 193, 7], (percent - 30) / 30);
        if (percent >= 90) return '#4CAF50';
        return this._interpolateColor([255, 193, 7], [76, 175, 80], (percent - 60) / 30);
    }

    _getColorClass(percent) {
        if (percent <= 15) return 'battery-critical';
        if (percent <= 30) return 'battery-low';
        if (percent <= 60) return 'battery-medium';
        return 'battery-high';
    }

    _interpolateColor(start, end, ratio) {
        const r = Math.round(start[0] + (end[0] - start[0]) * ratio);
        const g = Math.round(start[1] + (end[1] - start[1]) * ratio);
        const b = Math.round(start[2] + (end[2] - start[2]) * ratio);
        return `rgb(${r},${g},${b})`;
    }

    _formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) {
            return `${h}h ${m}m`;
        } else if (m > 0) {
            return `${m}m`;
        } else {
            return '< 1m';
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._bluetoothTimeoutId) {
            GLib.source_remove(this._bluetoothTimeoutId);
            this._bluetoothTimeoutId = null;
        }
        if (this._deviceAddedId) {
            this._upowerClient.disconnect(this._deviceAddedId);
            this._deviceAddedId = null;
        }
        if (this._deviceRemovedId) {
            this._upowerClient.disconnect(this._deviceRemovedId);
            this._deviceRemovedId = null;
        }
        if (this._themeChangedId) {
            this._settings.disconnect(this._themeChangedId);
            this._themeChangedId = null;
        }
        if (this._colorSchemeChangedId) {
            this._settings.disconnect(this._colorSchemeChangedId);
            this._colorSchemeChangedId = null;
        }
        if (this._bluezSignalId && this._bluezProxy) {
            this._bluezProxy.disconnectSignal(this._bluezSignalId);
            this._bluezSignalId = null;
        }
        if (this._bluezProxy) {
            this._bluezProxy = null;
        }
        super.destroy();
    }
});

export default class HorizontalBatteryExtension extends Extension {
    enable() {
        this._indicator = new HorizontalBatteryIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
