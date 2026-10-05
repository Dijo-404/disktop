mod actions;
mod archive;
mod base64;
mod content;
mod duplicates;
mod guard;
mod index;
mod journal;
mod manager;
mod mounts;
mod protocol;
mod query;
mod subtree;
mod sys;
mod transfer;
mod walk;

#[cfg(test)]
mod testing;

use std::io;

fn main() {
    // A tree at the depth limit needs a descriptor per level; see
    // `subtree::MAX_DEPTH`.
    sys::raise_descriptor_limit();
    let stdin = io::stdin();
    let stdout = io::stdout();

    if let Err(error) = protocol::serve(stdin.lock(), stdout) {
        eprintln!("disktop-fs: protocol I/O failed: {error}");
        std::process::exit(1);
    }
}
