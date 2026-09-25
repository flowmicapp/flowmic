#!/usr/bin/env python3
"""External GTK screen probe. Prints observed widget state, never a supplied verdict."""
import argparse
import json
import os
import time
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

parser = argparse.ArgumentParser()
parser.add_argument("--title", default="FlowMic Linux external target")
parser.add_argument("--seconds", type=int, default=30)
parser.add_argument("--output", required=True)
parser.add_argument("--screenshot")
parser.add_argument("--x", type=int, default=40)
args = parser.parse_args()
window = Gtk.Window(title=args.title)
window.set_default_size(520, 220)
window.move(args.x, 100)
entry = Gtk.TextView()
window.add(entry)
buffer = entry.get_buffer()


def record(event):
    start, end = buffer.get_bounds()
    data = {"event": event, "monotonic_ns": time.monotonic_ns(), "pid": os.getpid(),
            "backend": Gdk.Display.get_default().__gtype__.name,
            "title": window.get_title(), "active": window.is_active(),
            "text": buffer.get_text(start, end, True)}
    with open(args.output, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(data, ensure_ascii=False) + "\n")
    return True


def finish():
    record("finished")
    if args.screenshot:
        native = window.get_window()
        pixbuf = Gdk.pixbuf_get_from_window(native, 0, 0, native.get_width(), native.get_height())
        if pixbuf:
            pixbuf.savev(args.screenshot, "png", [], [])
    Gtk.main_quit()
    return False


window.connect("notify::is-active", lambda *_: record("active-changed"))
buffer.connect("changed", lambda *_: record("buffer-changed"))
window.connect("destroy", lambda *_: Gtk.main_quit())
window.show_all()
entry.grab_focus()
window.present()
GLib.timeout_add(250, lambda: record("sample"))
GLib.timeout_add_seconds(args.seconds, finish)
Gtk.main()
