# Optional Linux integration-test source. A real GTK/XDND file drag, not a DOM
# event, so Chromium must receive it through its operating-system drag path.
import json
import sys
from pathlib import Path
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib

window = Gtk.Window(title='pi native file drag test')
window.set_decorated(False)
window.set_keep_above(True)
window.set_default_size(240, 80)
window.move(900, 300)
box = Gtk.EventBox()
box.add(Gtk.Label(label='Drag OS file into pi'))
box.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,
                    [Gtk.TargetEntry.new('text/uri-list', 0, 0)], Gdk.DragAction.COPY | Gdk.DragAction.MOVE)
box.connect('drag-data-get', lambda _w, _c, selection, _i, _t:
            selection.set_uris([Path(p).as_uri() for p in sys.argv[1:]]))
box.connect('drag-begin', lambda *_: print('OS source: drag-begin', file=sys.stderr, flush=True))
box.connect('drag-end', lambda *_: print('OS source: drag-end', file=sys.stderr, flush=True))
window.add(box)
window.connect('destroy', Gtk.main_quit)
window.show_all()

def ready():
    _, x, y = window.get_window().get_origin()
    width, height = window.get_size()
    print(json.dumps(dict(x=x, y=y, width=width, height=height)), flush=True)
    return False

GLib.timeout_add(300, ready)
Gtk.main()
