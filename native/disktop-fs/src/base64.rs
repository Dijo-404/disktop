//! Base64 for raw path bytes, as the wire contract requires.
//!
//! Written here rather than pulled in as a dependency: the helper's job is to
//! keep filename bytes exact, and the encoding it depends on for that is small
//! enough to read in full. Decoding is strict — canonical padding, no
//! whitespace, no alternative alphabet — so one path cannot have two spellings.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (a << 16) | (b << 8) | c;

        encoded.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        encoded.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 63] as char
        } else {
            '='
        });
    }
    encoded
}

pub fn decode(text: &str) -> Result<Vec<u8>, &'static str> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err("base64 length must be a non-zero multiple of four");
    }

    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 {
        return Err("base64 has more than two padding characters");
    }

    let mut decoded = Vec::with_capacity(bytes.len() / 4 * 3);
    let groups = bytes.len() / 4;
    for (group, chunk) in bytes.chunks(4).enumerate() {
        // Padding ends the whole text, never one group in the middle of it.
        if group + 1 < groups && chunk.contains(&b'=') {
            return Err("base64 padding is misplaced");
        }
        let mut accumulator: u32 = 0;
        let mut significant = 0;
        for (position, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                // Padding is only ever the last one or two characters.
                if position < 2 || !chunk[position..].iter().all(|tail| *tail == b'=') {
                    return Err("base64 padding is misplaced");
                }
                accumulator <<= 6;
                continue;
            }
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => return Err("base64 contains a character outside the standard alphabet"),
            };
            accumulator = (accumulator << 6) | u32::from(value);
            significant += 1;
        }

        let produced = match significant {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return Err("base64 group carries no data"),
        };
        // The bits a padded group carries past its last byte are zero in the
        // one canonical spelling; anything else is a second spelling of the
        // same bytes.
        let unused = 8 * (3 - produced);
        if accumulator & ((1u32 << unused) - 1) != 0 {
            return Err("base64 has bits set past its last byte");
        }
        let triple = accumulator.to_be_bytes();
        decoded.extend_from_slice(&triple[1..1 + produced]);
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_bytes_that_are_not_valid_utf8() {
        let bytes = [b'/', b'h', 0xff, 0xfe, b'/', 0x00u8.wrapping_add(7)];
        assert_eq!(decode(&encode(&bytes)).unwrap(), bytes);
    }

    #[test]
    fn matches_the_canonical_encoding() {
        assert_eq!(encode(b"/home/example"), "L2hvbWUvZXhhbXBsZQ==");
        assert_eq!(decode("L2hvbWUvZXhhbXBsZQ==").unwrap(), b"/home/example");
    }

    #[test]
    fn refuses_non_canonical_input() {
        assert!(decode("").is_err());
        assert!(decode("L2hvbWU").is_err());
        assert!(decode("L2hv bWU=").is_err());
        assert!(decode("L2hvbWU_").is_err());
        assert!(decode("====").is_err());
    }

    /// Two spellings of one path would let a request name the same file twice
    /// and have a comparison of the spellings call them different.
    #[test]
    fn every_path_has_exactly_one_spelling() {
        assert_eq!(decode("QQ==").unwrap(), b"A");
        assert!(
            decode("QR==").is_err(),
            "bits past the last byte must be zero"
        );
        assert_eq!(decode("QUI=").unwrap(), b"AB");
        assert!(
            decode("QUJ=").is_err(),
            "bits past the last byte must be zero"
        );
        assert!(
            decode("QQ==QUJD").is_err(),
            "padding only ever ends the whole text"
        );
    }
}
