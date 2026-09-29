mod protocol;

use std::io;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();

    if let Err(error) = protocol::serve(stdin.lock(), stdout.lock()) {
        eprintln!("disktop-fs: protocol I/O failed: {error}");
        std::process::exit(1);
    }
}
