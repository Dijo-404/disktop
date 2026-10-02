mod actions;
mod base64;
// Consumed from Task 2 onwards by the duplicate finder, the copier, and the
// archiver. Until the first of those lands nothing calls it, and CI treats a
// clippy warning as an error.
#[allow(dead_code)]
mod content;
mod guard;
mod index;
mod journal;
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
