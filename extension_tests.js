/*
    Copyright © 2021 Aleksandr Mezin

    This file is part of ddterm GNOME Shell extension.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

'use strict';

/* exported enable disable */

const { GLib, Gio, Meta } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;
const JsUnit = imports.jsUnit;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Extension = Me.imports.extension;

const WindowMaximizeMode = {
    NOT_MAXIMIZED: Symbol('not-maximized'),
    EARLY: Symbol('maximize-early'),
    LATE: Symbol('maximize-late'),
};

let settings = null;
const window_trace = new Extension.ConnectionSet();

const PERCENT_FORMAT = new Intl.NumberFormat(undefined, { style: 'percent' });
const CURSOR_TRACKER_MOVED_SIGNAL = GObject.signal_lookup('cursor-moved', Meta.CursorTracker) ? 'cursor-moved' : 'position-invalidated';

const DEFAULT_IDLE_TIMEOUT_MS = Meta.MAJOR_VERSION === 3 && Meta.MINOR_VERSION === 36 ? 300 : 200;

class Reporter {
    constructor(prefix = '') {
        this.prefix = prefix;
    }

    print(...params) {
        const stack = JsUnit.parseErrorStack(new Error());
        print(this.prefix, `[${stack[1]}]`, ...params);
    }

    child(prefix = '  ') {
        return new Reporter(`${this.prefix}${prefix}`);
    }
}

const DEFAULT_REPORTER = new Reporter();

class ExtensionTestDBusInterface {
    constructor() {
        let [_, xml] = Me.dir.get_child('com.github.amezin.ddterm.ExtensionTest.xml').load_contents(null);
        this.dbus = Gio.DBusExportedObject.wrapJSObject(ByteArray.toString(xml), this);
    }

    RunTestAsync(params, invocation) {
        run_tests(...params).then(_ => {
            invocation.return_value(null);
        }).catch(e => {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                let name = e.name;
                if (!name.includes('.')) {
                    // likely to be a normal JS error
                    name = `org.gnome.gjs.JSError.${name}`;
                }
                logError(e, `Exception in method call: ${invocation.get_method_name()}`);
                invocation.return_dbus_error(name, `${e}\n\n${e.stack}`);
            }
        });
    }
}

const DBUS_INTERFACE = new ExtensionTestDBusInterface();

function enable() {
    DBUS_INTERFACE.dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/ddterm');
}

function disable() {
    DBUS_INTERFACE.dbus.unexport();
}

function setup_window_trace() {
    const win = Extension.current_window;

    DEFAULT_REPORTER.print(`current window changed: ${win}`);

    window_trace.disconnect();

    if (!win)
        return;

    window_trace.connect(win, 'position-changed', () => {
        const rect = win.get_frame_rect();
        DEFAULT_REPORTER.print(`position-changed: { .x = ${rect.x}, .y = ${rect.y}, .width = ${rect.width}, .height = ${rect.height} }`);
    });

    window_trace.connect(win, 'size-changed', () => {
        const rect = win.get_frame_rect();
        DEFAULT_REPORTER.print(`size-changed: { .x = ${rect.x}, .y = ${rect.y}, .width = ${rect.width}, .height = ${rect.height} }`);
    });

    window_trace.connect(win, 'notify::maximized-vertically', () => {
        DEFAULT_REPORTER.print(`notify::maximized-vertically = ${win.maximized_vertically}`);
    });

    window_trace.connect(win, 'notify::maximized-horizontally', () => {
        DEFAULT_REPORTER.print(`notify::maximized-horizontally = ${win.maximized_horizontally}`);
    });
}

function hide_window_async_wait(reporter) {
    return new Promise(resolve => {
        if (!Extension.current_window) {
            resolve();
            return;
        }

        const check_cb = () => {
            if (Extension.current_window)
                return;

            Extension.disconnect(handler);
            child_reporter.print('Window hidden');
            resolve();
        };

        const handler = Extension.connect('window-changed', check_cb);

        reporter.print('Hiding the window');
        const child_reporter = reporter.child();
        Extension.toggle();
    });
}

function async_wait_current_window(reporter) {
    return new Promise(resolve => {
        reporter.print('Waiting for the window to show');
        const child_reporter = reporter.child();

        const shown_handler = new Extension.ConnectionSet();

        const check_cb = () => {
            const current_win = Extension.current_window;

            if (!current_win)
                return;

            shown_handler.disconnect();

            if (current_win.is_hidden()) {
                shown_handler.connect(current_win, 'shown', check_cb);
                return;
            }

            Extension.disconnect(win_handler);
            child_reporter.print('Window shown');
            resolve();
        };

        const win_handler = Extension.connect('window-changed', check_cb);
        check_cb();
    });
}

function wait_window_settle(reporter, idle_timeout_ms = DEFAULT_IDLE_TIMEOUT_MS) {
    return new Promise(resolve => {
        const win = Extension.current_window;
        const cursor_tracker = Meta.CursorTracker.get_for_display(global.display);
        let timer_id = null;
        const handlers = new Extension.ConnectionSet();

        reporter.print('Waiting for the window to stop generating events');
        const child_reporter = reporter.child();

        const ready = () => {
            handlers.disconnect();
            resolve();
            child_reporter.print('Idle timeout elapsed');
            return GLib.SOURCE_REMOVE;
        };

        const restart_timer = () => {
            if (timer_id !== null)
                GLib.source_remove(timer_id);

            timer_id = GLib.timeout_add(GLib.PRIORITY_LOW, idle_timeout_ms, ready);
        };

        handlers.connect(win, 'position-changed', () => {
            child_reporter.print('Restarting wait because of position-changed signal');
            restart_timer();
        });
        handlers.connect(win, 'size-changed', () => {
            child_reporter.print('Restarting wait because of size-changed signal');
            restart_timer();
        });
        handlers.connect(win, 'notify::maximized-vertically', () => {
            child_reporter.print('Restarting wait because of notify::maximized-vertically signal');
            restart_timer();
        });
        handlers.connect(win, 'notify::maximized-horizontally', () => {
            child_reporter.print('Restarting wait because of notify::maximized-horizontally signal');
            restart_timer();
        });
        handlers.connect(Extension, 'move-resize-requested', () => {
            child_reporter.print('Restarting wait because of move-resize-requested signal');
            restart_timer();
        });
        handlers.connect(cursor_tracker, CURSOR_TRACKER_MOVED_SIGNAL, () => {
            child_reporter.print('Restarting wait because cursor moved');
            restart_timer();
        });

        restart_timer();
    });
}

function connect_once(object, signal, callback) {
    const handler_id = object.connect(signal, (...params) => {
        object.disconnect(handler_id);
        callback(...params);
    });
    return handler_id;
}

function async_wait_signal(object, signal) {
    return new Promise(resolve => connect_once(object, signal, resolve));
}

function async_run_process(reporter, argv) {
    return new Promise(resolve => {
        reporter.print(`Starting subprocess ${JSON.stringify(argv)}`);
        const child_reporter = reporter.child();
        const subprocess = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        subprocess.wait_check_async(null, (source, result) => {
            child_reporter.print(`Finished subprocess ${JSON.stringify(argv)}`);
            resolve(source.wait_check_finish(result));
        });
    });
}

function set_setting(reporter, name, value) {
    return new Promise(resolve => {
        const check_value = () => {
            if (!settings.get_value(name).equal(value))
                return false;

            settings.disconnect(handler_id);
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            return true;
        };

        const handler_id = settings.connect(`changed::${name}`, check_value);

        if (check_value())
            return;

        reporter.print(`Setting ${name}=${value.unpack()}`);
        settings.set_value(name, value);
    });
}

function set_settings_double(reporter, name, value) {
    return set_setting(reporter, name, GLib.Variant.new_double(value));
}

function set_settings_boolean(reporter, name, value) {
    return set_setting(reporter, name, GLib.Variant.new_boolean(value));
}

function set_settings_string(reporter, name, value) {
    return set_setting(reporter, name, GLib.Variant.new_string(value));
}

function assert_rect_equals(reporter, expected, actual) {
    reporter.print(`Checking if rect { .x=${actual.x}, .y=${actual.y}, .width=${actual.width}, .height=${actual.height} } matches expected { .x=${expected.x}, .y=${expected.y}, .width=${expected.width}, .height=${expected.height} }`);
    JsUnit.assertEquals(expected.x, actual.x);
    JsUnit.assertEquals(expected.y, actual.y);
    JsUnit.assertEquals(expected.width, actual.width);
    JsUnit.assertEquals(expected.height, actual.height);
}

function verify_window_geometry(reporter, window_size, window_maximize, window_pos) {
    const monitor_index = Main.layoutManager.currentMonitor.index;
    const workarea = Main.layoutManager.getWorkAreaForMonitor(monitor_index);
    const monitor_scale = global.display.get_monitor_scale(monitor_index);
    const frame_rect = Extension.current_window.get_frame_rect();

    reporter.print(`Verifying window geometry (expected size=${window_size}, maximized=${window_maximize}, position=${window_pos})`);
    const child_reporter = reporter.child();

    if (window_pos === 'top' || window_pos === 'bottom')
        JsUnit.assertEquals(window_maximize, Extension.current_window.maximized_vertically);
    else
        JsUnit.assertEquals(window_maximize, Extension.current_window.maximized_horizontally);

    if (window_maximize) {
        assert_rect_equals(child_reporter, workarea, frame_rect);
        return;
    }

    const target_rect = Extension.target_rect_for_workarea_size(workarea, monitor_scale, window_size);

    const workarea_right = workarea.x + workarea.width;
    const workarea_bottom = workarea.y + workarea.height;
    const frame_rect_right = frame_rect.x + frame_rect.width;
    const frame_rect_bottom = frame_rect.y + frame_rect.height;

    if (window_pos === 'top') {
        child_reporter.print('Making sure the window is attached to top edge');
        JsUnit.assertEquals(workarea.x, frame_rect.x);
        JsUnit.assertEquals(workarea_right, frame_rect_right);
        JsUnit.assertEquals(workarea.y, frame_rect.y);
    }

    if (window_pos === 'bottom') {
        child_reporter.print('Making sure the window is attached to bottom edge');
        JsUnit.assertEquals(workarea.x, frame_rect.x);
        JsUnit.assertEquals(workarea_right, frame_rect_right);
        JsUnit.assertEquals(workarea_bottom, frame_rect_bottom);
    }

    if (window_pos === 'left') {
        child_reporter.print('Making sure the window is attached to left edge');
        JsUnit.assertEquals(workarea.x, frame_rect.x);
        JsUnit.assertEquals(workarea.y, frame_rect.y);
        JsUnit.assertEquals(workarea_bottom, frame_rect_bottom);
    }

    if (window_pos === 'right') {
        child_reporter.print('Making sure the window is attached to right edge');
        JsUnit.assertEquals(workarea_right, frame_rect_right);
        JsUnit.assertEquals(workarea.y, frame_rect.y);
        JsUnit.assertEquals(workarea_bottom, frame_rect_bottom);
    }

    assert_rect_equals(child_reporter, target_rect, frame_rect);

    child_reporter.print('Window geometry is fine');
}

async function test_show(reporter, window_size, window_maximize, window_pos) {
    reporter.print(`Starting test with window size=${window_size}, maximize=${window_maximize.toString()}, position=${window_pos}`);
    const child_reporter = reporter.child();
    await hide_window_async_wait(child_reporter);

    await set_settings_double(child_reporter, 'window-size', window_size);
    await set_settings_boolean(child_reporter, 'window-maximize', window_maximize === WindowMaximizeMode.EARLY);
    await set_settings_string(child_reporter, 'window-position', window_pos);

    Extension.toggle();

    await async_wait_current_window(child_reporter);
    await wait_window_settle(child_reporter);

    verify_window_geometry(child_reporter, window_size, window_maximize === WindowMaximizeMode.EARLY || window_size === 1.0, window_pos);

    if (window_maximize === WindowMaximizeMode.LATE) {
        await set_settings_boolean(child_reporter, 'window-maximize', true);
        await wait_window_settle(child_reporter);

        verify_window_geometry(child_reporter, window_size, true, window_pos);
    }
}

async function test_unmaximize(reporter, window_size, window_maximize, window_pos) {
    await test_show(reporter, window_size, window_maximize, window_pos);

    await set_settings_boolean(reporter, 'window-maximize', false);
    await wait_window_settle(reporter);
    verify_window_geometry(reporter, window_size, window_size === 1.0, window_pos);
}

async function test_unmaximize_correct_size(reporter, window_size, window_size2, window_pos) {
    await test_show(reporter, window_size, WindowMaximizeMode.NOT_MAXIMIZED, window_pos);

    await set_settings_double(reporter, 'window-size', window_size2);
    await wait_window_settle(reporter);
    verify_window_geometry(reporter, window_size2, window_size === 1.0 && window_size2 === 1.0, window_pos);

    await set_settings_boolean(reporter, 'window-maximize', true);
    await wait_window_settle(reporter);
    verify_window_geometry(reporter, window_size2, true, window_pos);

    await set_settings_boolean(reporter, 'window-maximize', false);
    await wait_window_settle(reporter);
    verify_window_geometry(reporter, window_size2, window_size2 === 1.0, window_pos);
}

async function test_unmaximize_on_size_change(reporter, window_size, window_size2, window_pos) {
    await test_show(reporter, window_size, WindowMaximizeMode.EARLY, window_pos);

    await set_settings_double(reporter, 'window-size', window_size2);
    await wait_window_settle(reporter);

    verify_window_geometry(reporter, window_size2, window_size2 === 1.0, window_pos);
}

function resize_point(frame_rect, window_pos, monitor_scale) {
    let x = frame_rect.x, y = frame_rect.y;
    const edge_offset = 3 * monitor_scale;

    if (window_pos === 'left' || window_pos === 'right') {
        y += Math.floor(frame_rect.height / 2);

        if (window_pos === 'left')
            x += frame_rect.width - edge_offset;
        else
            x += edge_offset;
    } else {
        x += Math.floor(frame_rect.width / 2);

        if (window_pos === 'top')
            y += frame_rect.height - edge_offset;
        else
            y += edge_offset;
    }

    return { x, y };
}

async function test_resize_xte_flaky(reporter, window_size, window_maximize, window_size2, window_pos) {
    await test_show(reporter, window_size, window_maximize, window_pos);

    const monitor_index = Main.layoutManager.currentMonitor.index;
    const workarea = Main.layoutManager.getWorkAreaForMonitor(monitor_index);
    const monitor_scale = global.display.get_monitor_scale(monitor_index);

    const initial_frame_rect = Extension.current_window.get_frame_rect();
    const initial = resize_point(initial_frame_rect, window_pos, monitor_scale);

    const target_frame_rect = Extension.target_rect_for_workarea_size(workarea, monitor_scale, window_size2);
    const target = resize_point(target_frame_rect, window_pos, monitor_scale);

    await async_run_process(reporter, ['xte', `mousemove ${initial.x} ${initial.y}`, 'mousedown 1']);
    await wait_window_settle(reporter);

    try {
        verify_window_geometry(reporter, window_maximize !== WindowMaximizeMode.NOT_MAXIMIZED ? 1.0 : window_size, false, window_pos);
    } finally {
        await async_run_process(reporter, ['xte', `mousermove ${target.x - initial.x} ${target.y - initial.y}`, 'mouseup 1']);
    }
    await wait_window_settle(reporter);

    verify_window_geometry(reporter, window_size2, false, window_pos);

    // TODO: 'grab-op-end' isn't emitted on Wayland when simulting mouse with xte.
    // For now, just call update_size_setting_on_grab_end()
    if (Meta.is_wayland_compositor())
        Extension.update_size_setting_on_grab_end(global.display, Extension.current_window);

    assert_rect_equals(reporter, target_frame_rect, Extension.current_target_rect);
}

async function test_resize_xte(reporter, window_size, window_maximize, window_size2, window_pos) {
    try {
        await test_resize_xte_flaky(reporter, window_size, window_maximize, window_size2, window_pos);
    } catch (e) {
        logError(e, 'Trying again');
        await test_resize_xte_flaky(reporter, window_size, window_maximize, window_size2, window_pos);
    }
}

async function test_change_position(reporter, window_size, window_pos, window_pos2) {
    await test_show(reporter, window_size, false, window_pos);

    await set_settings_string(reporter, 'window-position', window_pos2);
    await wait_window_settle(reporter);

    verify_window_geometry(reporter, window_size, window_size === 1.0, window_pos2);
}

async function run_tests(filter = '', filter_out = false) {
    // There should be something from (0; 0.8), (0.8; 1.0), and 1.0
    // The shell starts auto-maximizing the window when it occupies 80% of the
    // workarea. ddterm tries to immediately unmaximize the window in this case.
    // At 100% (1.0), ddterm doesn't unmaximize the window.
    const SIZE_VALUES = [0.5, 0.9, 1.0];
    const MAXIMIZE_MODES = [
        WindowMaximizeMode.NOT_MAXIMIZED,
        WindowMaximizeMode.EARLY,
        WindowMaximizeMode.LATE,
    ];
    const POSITIONS = ['top', 'bottom', 'left', 'right'];
    const tests = [];

    const add_test = (func, ...args) => tests.push({
        func,
        args,
        id: `${JsUnit.getFunctionName(func)}(${args.map(x => x.toString())})`,
    });

    settings = Extension.settings;

    for (let window_size of [0.31, 0.36, 0.4, 0.8, 0.85, 0.91]) {
        for (let window_maximize of MAXIMIZE_MODES) {
            for (let window_pos of POSITIONS)
                add_test(test_show, window_size, window_maximize, window_pos);
        }
    }

    for (let window_size of SIZE_VALUES) {
        for (let window_maximize of MAXIMIZE_MODES) {
            for (let window_size2 of SIZE_VALUES) {
                for (let window_pos of POSITIONS)
                    add_test(test_resize_xte, window_size, window_maximize, window_size2, window_pos);
            }
        }
    }

    for (let window_size of SIZE_VALUES) {
        for (let window_pos of POSITIONS) {
            for (let window_pos2 of POSITIONS) {
                if (window_pos !== window_pos2)
                    add_test(test_change_position, window_size, window_pos, window_pos2);
            }
        }
    }

    for (let window_pos of POSITIONS) {
        for (let window_maximize of MAXIMIZE_MODES) {
            for (let window_size of SIZE_VALUES)
                add_test(test_unmaximize, window_size, window_maximize, window_pos);
        }

        for (let window_size of SIZE_VALUES) {
            for (let window_size2 of SIZE_VALUES)
                add_test(test_unmaximize_correct_size, window_size, window_size2, window_pos);
        }

        for (let window_size of SIZE_VALUES) {
            for (let window_size2 of SIZE_VALUES) {
                if (window_size !== window_size2)
                    add_test(test_unmaximize_on_size_change, window_size, window_size2, window_pos);
            }
        }
    }

    if (global.settings.settings_schema.has_key('welcome-dialog-last-shown-version'))
        global.settings.set_string('welcome-dialog-last-shown-version', '99.0');

    if (Main.welcomeDialog) {
        const ModalDialog = imports.ui.modalDialog;
        if (Main.welcomeDialog.state !== ModalDialog.State.CLOSED) {
            Main.welcomeDialog.close();
            await async_wait_signal(Main.welcomeDialog, 'closed');
        }
    }

    const filter_func = info => info.id.match(filter);
    const filtered_tests = tests.filter(filter_out ? info => !filter_func(info) : filter_func);
    let tests_passed = 0;
    for (let test of filtered_tests) {
        DEFAULT_REPORTER.print('------------------------------------------------------------------------------------------------------------------------------------------');
        DEFAULT_REPORTER.print(`Running test ${test.id} (${tests_passed} of ${filtered_tests.length} done, ${PERCENT_FORMAT.format(tests_passed / filtered_tests.length)})`);
        const handler = Extension.connect('window-changed', setup_window_trace);
        try {
            // eslint-disable-next-line no-await-in-loop
            await test.func(DEFAULT_REPORTER.child(), ...test.args);
        } catch (e) {
            e.message += `\n${test.id})`;
            throw e;
        } finally {
            Extension.disconnect(handler);
        }
        tests_passed += 1;
    }
}
