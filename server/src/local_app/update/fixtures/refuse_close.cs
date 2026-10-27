using System;
using System.Runtime.InteropServices;
public class CursorCloseFixture {
    delegate IntPtr WndProc(IntPtr window,uint message,IntPtr w,IntPtr l);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {
        public uint style; public WndProc procedure; public int classExtra,windowExtra;
        public IntPtr instance,icon,cursor,background; public string menu,name;
    }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr window; public uint message; public UIntPtr w; public IntPtr l;
        public uint time; public int x,y; public uint extra;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref WindowClass value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint extra,string name,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr parameter);
    [DllImport("user32.dll")] static extern int GetMessage(out Message message,IntPtr window,uint low,uint high);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr window,uint message,IntPtr w,IntPtr l);
    static WndProc handler=(window,message,w,l)=>message==0x0010?IntPtr.Zero:DefWindowProc(window,message,w,l);
    public static void Main() {
        var instance=GetModuleHandle(null);
        var cls=new WindowClass{procedure=handler,instance=instance,name="Chrome_WidgetWin_1"};
        if(RegisterClass(ref cls)==0)throw new Exception("Could not register close-cancellation fixture.");
        if(CreateWindowEx(0,cls.name,"BYOK close-cancellation fixture",0x00CF0000,0,0,400,200,IntPtr.Zero,IntPtr.Zero,instance,IntPtr.Zero)==IntPtr.Zero)throw new Exception("Could not create close-cancellation fixture.");
        Message message;
        while(GetMessage(out message,IntPtr.Zero,0,0)>0){TranslateMessage(ref message);DispatchMessage(ref message);}
    }
}
