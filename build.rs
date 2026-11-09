// Gives the Windows build an icon and version information (shown in
// Explorer and the taskbar). Other platforms need nothing here.
fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=public");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico")
            .set("ProductName", "RBWR Demands")
            .set("FileDescription", "RBWR Demands")
            .set("LegalCopyright", "MIT License")
            .set("Comments", "Live grid demands for Realistic Boiling Water Reactor Simulator servers. Fan-made.");
        if let Err(e) = res.compile() {
            panic!("Could not embed the Windows icon: {e}");
        }
    }
}
