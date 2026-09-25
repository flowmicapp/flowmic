// SPEC-REF: Linux desktop L-3. ICCCM selection property representation.
// The X11 wire's format 32 occupies native unsigned-long entries in Xlib (8
// bytes on LP64). Snapshot bytes use fixed-width little endian instead, so
// neither target atoms nor resource handles can masquerade as Win32 formats.

use crate::focus::linux_x11::Connection;
use std::ffi::c_ulong;
use std::ptr;
use x11_dl::xlib;

pub(super) const LIMIT: usize = 64 * 1024 * 1024;
pub(super) const CHUNK: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Value {
    pub kind: xlib::Atom,
    pub width: i32,
    pub bytes: Vec<u8>,
}

impl Value {
    pub fn words(kind: xlib::Atom, words: &[c_ulong]) -> Self {
        Self {
            kind,
            width: 32,
            bytes: words
                .iter()
                .flat_map(|v| (*v as u32).to_le_bytes())
                .collect(),
        }
    }
    pub fn as_words(&self) -> Result<Vec<c_ulong>, String> {
        if self.width != 32 || !self.bytes.len().is_multiple_of(4) {
            return Err("expected format-32 property".into());
        }
        Ok(self
            .bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| u32::from_le_bytes(*b) as c_ulong)
            .collect())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = self.kind.to_le_bytes().to_vec();
        bytes.extend_from_slice(&self.width.to_le_bytes());
        bytes.extend_from_slice(&self.bytes);
        bytes
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 12 {
            return Err("truncated X11 snapshot value".into());
        }
        let kind = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as c_ulong;
        let width = i32::from_le_bytes(bytes[8..12].try_into().unwrap());
        if !matches!(width, 8 | 16 | 32) || !(bytes.len() - 12).is_multiple_of(width as usize / 8) {
            return Err("invalid X11 snapshot format width".into());
        }
        Ok(Self {
            kind,
            width,
            bytes: bytes[12..].to_vec(),
        })
    }
}

pub(super) fn read(
    c: &Connection,
    window: xlib::Window,
    property: xlib::Atom,
) -> Result<Value, String> {
    let (mut kind, mut width, mut count, mut after) = (0, 0, 0, 0);
    let mut pointer = ptr::null_mut();
    let status = unsafe {
        (c.api.XGetWindowProperty)(
            c.display,
            window,
            property,
            0,
            (LIMIT / 4) as _,
            0,
            xlib::AnyPropertyType as _,
            &mut kind,
            &mut width,
            &mut count,
            &mut after,
            &mut pointer,
        )
    };
    let result = (|| {
        if status != 0 || after != 0 {
            return Err("XGetWindowProperty failed or exceeded 64 MiB".into());
        }
        if !matches!(width, 8 | 16 | 32) {
            return Err(format!("selection property has format {width}"));
        }
        if count as usize > LIMIT / (width as usize / 8) {
            return Err("selection property exceeds 64 MiB".into());
        }
        let bytes = if count == 0 {
            Vec::new()
        } else {
            if pointer.is_null() {
                return Err("XGetWindowProperty returned a null buffer".into());
            }
            unsafe {
                match width {
                    8 => std::slice::from_raw_parts(pointer, count as usize).to_vec(),
                    16 => std::slice::from_raw_parts(pointer.cast::<u16>(), count as usize)
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect(),
                    32 => std::slice::from_raw_parts(pointer.cast::<c_ulong>(), count as usize)
                        .iter()
                        .flat_map(|v| (*v as u32).to_le_bytes())
                        .collect(),
                    _ => unreachable!(),
                }
            }
        };
        Ok(Value { kind, width, bytes })
    })();
    if !pointer.is_null() {
        unsafe {
            (c.api.XFree)(pointer.cast());
        }
    }
    c.sync()?;
    result
}

pub(super) fn write(
    c: &Connection,
    window: xlib::Window,
    property: xlib::Atom,
    value: &Value,
) -> Result<(), String> {
    let words16: Vec<u16> = value
        .bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_le_bytes(*b))
        .collect();
    let words32: Vec<c_ulong> = value
        .bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| u32::from_le_bytes(*b) as c_ulong)
        .collect();
    let pointer = match value.width {
        8 => value.bytes.as_ptr(),
        16 => words16.as_ptr().cast(),
        32 => words32.as_ptr().cast(),
        _ => return Err("invalid outgoing property width".into()),
    };
    unsafe {
        (c.api.XChangeProperty)(
            c.display,
            window,
            property,
            value.kind,
            value.width,
            xlib::PropModeReplace,
            pointer,
            (value.bytes.len() / (value.width as usize / 8)) as _,
        );
    }
    c.sync()
}

pub(super) fn metadata(name: &str) -> bool {
    matches!(
        name,
        "TARGETS" | "TIMESTAMP" | "MULTIPLE" | "SAVE_TARGETS" | "TARGET_SIZES"
    )
}
pub(super) fn byte_target(name: &str) -> bool {
    matches!(name, "UTF8_STRING" | "STRING" | "TEXT" | "COMPOUND_TEXT") || name.contains('/')
}
pub(super) fn resource_type(kind: xlib::Atom) -> bool {
    matches!(
        kind,
        xlib::XA_PIXMAP
            | xlib::XA_DRAWABLE
            | xlib::XA_WINDOW
            | xlib::XA_COLORMAP
            | xlib::XA_CURSOR
            | xlib::XA_FONT
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_selection_formats_preserve_width_and_refuse_resource_targets() {
        for width in [8, 16, 32] {
            let value = Value {
                kind: 234,
                width,
                bytes: vec![0x12, 0xAB, 0, 0xCD],
            };
            assert_eq!(Value::decode(&value.encode()).unwrap(), value);
        }
        let words = Value::words(xlib::XA_ATOM, &[2, 17, 0xFEDC_BA98]);
        assert_eq!(words.as_words().unwrap(), vec![2, 17, 0xFEDC_BA98]);
        for target in [
            "DELETE",
            "PIXMAP",
            "DRAWABLE",
            "INSERT_SELECTION",
            "_UNKNOWN",
        ] {
            assert!(!byte_target(target), "{target}");
        }
        for target in [
            "UTF8_STRING",
            "text/html",
            "image/png",
            "application/x-custom",
        ] {
            assert!(byte_target(target), "{target}");
        }
        assert!(resource_type(xlib::XA_PIXMAP));
        assert!(!resource_type(xlib::XA_STRING));
    }
}
