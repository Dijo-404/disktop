mod base64;
mod index;
mod protocol;
mod query;
mod sys;
mod walk;

#[cfg(test)]
mod testing;

use std::io;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();

    if let Err(error) = protocol::serve(stdin.lock(), stdout) {
        eprintln!("disktop-fs: protocol I/O failed: {error}");
        std::process::exit(1);
    }
}
