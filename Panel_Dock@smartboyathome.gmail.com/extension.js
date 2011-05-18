/* Panel Dock: Surgically combining the Dock extension with the third party panel favorites extension. */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const AppFavorites = imports.ui.appFavorites;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;

function PanelButton(app) {
    this._init(app);
}

PanelButton.prototype = {
    _init: function(app) {
        this.app = app;
        this.actor = new St.Button({ name: 'PanelButton',
                                    reactive: true,
                                    style_class: 'dock-app' });
        this._icon = app.create_icon_texture(24);
        this.actor.set_child(this._icon);
        this.actor._delegate = this;
        this.actor.set_tooltip_text(app.get_name()+'\n'+app.get_description());
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this._has_focus = false;

        let tracker = Shell.WindowTracker.get_default();
        tracker.connect('notify::focus-app', Lang.bind(this, this._onStateChanged));

        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
        this.actor.connect('notify::hover', Lang.bind(this, this._hoverChanged));

        this._menuTimeoutId = 0;
        this._stateChangedId = this.app.connect('notify::state',
                                                Lang.bind(this, this._onStateChanged));
        this._onStateChanged();
    },

    _onDestroy: function() {
        if (this._stateChangedId > 0)
            this.app.disconnect(this._stateChangedId);
        this._stateChangedId = 0;
        this._removeMenuTimeout();
    },

    _removeMenuTimeout: function() {
        if (this._menuTimeoutId > 0) {
            Mainloop.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    },

    _hoverChanged: function(actor) {
        if (actor != this.actor)
            this._has_focus = false;
        else
            this._has_focus = true;
        return false;
    },

    _onStateChanged: function() {
        let tracker = Shell.WindowTracker.get_default();
        let focusedApp = tracker.focus_app;
        if (this.app.state != Shell.AppState.STOPPED) {
            this.actor.add_style_class_name('running');
            if (this.app == focusedApp) {
                this.actor.add_style_class_name('focused');
            } else {
                this.actor.remove_style_class_name('focused');
            }
        } else {
            this.actor.remove_style_class_name('focused');
            this.actor.remove_style_class_name('running');
        }
    },

    _onButtonPress: function(actor, event) {
        let button = event.get_button();
        if (button == 1) {
            this._removeMenuTimeout();
            this._menuTimeoutId = Mainloop.timeout_add(AppDisplay.MENU_POPUP_TIMEOUT, Lang.bind(this, function() {
                this.popupMenu();
            }));
        } else if (button == 3) {
            this.popupMenu();
        }
    },

    _onClicked: function(actor, button) {
        this._removeMenuTimeout();

        if (button == 1) {
            this._onActivate(Clutter.get_current_event());
        } else if (button == 2) {
            // Last workspace is always empty
            let launchWorkspace = global.screen.get_workspace_by_index(global.screen.n_workspaces - 1);
            launchWorkspace.activate(global.get_current_time());
            //this.emit('launching');
            this.app.open_new_window(-1);
        }
        return false;
    },

    getId: function() {
        return this.app.get_id();
    },

    popupMenu: function() {
        this._removeMenuTimeout();
        this.actor.fake_release();

        if (!this._menu) {
            this._menu = new DockIconMenu(this);
            this._menu.connect('activate-window', Lang.bind(this, function (menu, window) {
                this.activateWindow(window);
            }));
            this._menu.connect('popup', Lang.bind(this, function (menu, isPoppedUp) {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            }));

            this._menuManager.addMenu(this._menu, true);
        }

        this._menu.popup();

        return false;
    },

    activateWindow: function(metaWindow) {
        if (metaWindow) {
            this._didActivateWindow = true;
            Main.activateWindow(metaWindow);
        }
    },

    setSelected: function (isSelected) {
        this._selected = isSelected;
        if (this._selected)
            this.actor.add_style_class_name('selected');
        else
            this.actor.remove_style_class_name('selected');
    },

    _onMenuPoppedDown: function() {
        this.actor.sync_hover();
    },

    _getRunning: function() {
        return this.app.state != Shell.AppState.STOPPED;
    },

    _onActivate: function (event) {
        //this.emit('launching');
        let modifiers = Shell.get_event_state(event);

        if (modifiers & Clutter.ModifierType.CONTROL_MASK
            && this.app.state == Shell.AppState.RUNNING) {
            let current_workspace = global.screen.get_active_workspace().index();
            this.app.open_new_window(current_workspace);
        } else {
            let tracker = Shell.WindowTracker.get_default();
            let focusedApp = tracker.focus_app;

            if (this.app == focusedApp) {
                let windows = this.app.get_windows();
                let current_workspace = global.screen.get_active_workspace();
                for (let i = 0; i < windows.length; i++) {
                    let w = windows[i];
                    if (w.get_workspace() == current_workspace)
                        w.minimize();
                }
            } else {
                this.app.activate(-1);
            }
        }
        Main.overview.hide();
    },

    shellWorkspaceLaunch : function() {
        this.app.open_new_window();
    }
};

function PanelDock() {
    this._init();
}

PanelDock.prototype = {
    _init: function() {
        this.actor = new St.BoxLayout({ name: 'PanelDock',
                                         style_class: 'panel-favorites' });
        this._display();

        Shell.WindowTracker.get_default().connect('app-state-changed', Lang.bind(this, this._redisplay));
        Shell.AppSystem.get_default().connect('installed-changed', Lang.bind(this, this._redisplay));
        AppFavorites.getAppFavorites().connect('changed', Lang.bind(this, this._redisplay));
    },

    _redisplay: function() {
        for ( let i=0; i<this._buttons.length; ++i ) {
            this._buttons[i].actor.destroy();
        }

        this._display();
    },

    _display: function() {
        let favorites = AppFavorites.getAppFavorites().getFavoriteMap();
        let running = Shell.WindowTracker.get_default().get_running_apps('');

        this._buttons = [];
        let j = 0;
        for ( let id in favorites ) {
            let app = favorites[id];
            this._buttons[j] = new PanelButton(app);
            this.actor.add(this._buttons[j].actor);
            ++j;
        }
        for (let i = 0; i < running.length; i++) {
            let app = running[i];
            if (app.get_id() in favorites)
                continue;
            this._buttons[j] = new PanelButton(app);
            this.actor.add(this._buttons[j].actor);
            ++j;
        }
    }
};

function main() {
    let panelDock = new PanelDock();
    Main.panel._leftBox.insert_actor(panelDock.actor, 1);
}
