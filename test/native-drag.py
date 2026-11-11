import ctypes, json, sys, time
# Optional Linux/X11 integration-test driver. Sends real mouse/key events;
# unlike dispatchEvent(), this traverses VS Code's native drag routing.
x = ctypes.CDLL('libX11.so.6'); t = ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes=[ctypes.c_char_p]; x.XOpenDisplay.restype=ctypes.c_void_p
x.XFlush.argtypes=[ctypes.c_void_p]; x.XCloseDisplay.argtypes=[ctypes.c_void_p]
x.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong];x.XKeysymToKeycode.restype=ctypes.c_ubyte
t.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong]
t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
t.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
d=x.XOpenDisplay(None)
if not d: raise RuntimeError('No X11 display')
a=json.loads(sys.argv[1]); shift=x.XKeysymToKeycode(d,0xffe1)
def move(px,py):
 t.XTestFakeMotionEvent(d,-1,round(px),round(py),0);x.XFlush(d);time.sleep(.025)
def button(down):
 t.XTestFakeButtonEvent(d,1,down,0);x.XFlush(d);time.sleep(.1)
def key(down):
 t.XTestFakeKeyEvent(d,shift,down,0);x.XFlush(d);time.sleep(.1)
fx,fy=a['from'];tx,ty=a['to']
try:
 move(fx,fy);button(1);move(fx,fy+15)
 if a['shift']: key(1)
 cx,cy=fx,fy+15
 for px,py,pause in a.get('via',[])+[[tx,ty,0]]:
  for i in range(1,31): move(cx+(px-cx)*i/30,cy+(py-cy)*i/30)
  time.sleep(pause);cx,cy=px,py
 time.sleep(.3);move(tx+5,ty);time.sleep(.5);button(0)
finally:
 if a['shift']: key(0)
 button(0);x.XCloseDisplay(d)
