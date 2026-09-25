// SPEC-REF: Linux desktop L-3. ICCCM §2 selection owner/requestor lifetimes.
// Never infer an editor receipt from SelectionRequest: clipboard bridges and
// managers ask for data too. Generation checks protect a user's intervening copy.

use super::transfer::{self, Value, CHUNK, LIMIT};
use crate::focus::linux_x11::Connection;
use crate::inject::ClipboardSnapshot;
use std::collections::HashMap;
use std::ffi::CStr;
use std::time::{Duration, Instant};
use x11_dl::xlib;

#[path = "generation.rs"]
mod generation;

const TOKEN: u32 = u32::MAX;
const DEADLINE: Duration = Duration::from_secs(3);

struct Outgoing {
    value: Value,
    offset: usize,
    deadline: Instant,
}
struct Saved {
    token: u64,
    previous_owner: xlib::Window,
    previous_revision: u64,
    previous_timestamp: Option<Vec<u8>>,
    replacement_generation: Option<(u64, u64)>,
}

pub(super) struct Owner {
    pub connection: Connection,
    window: xlib::Window,
    clipboard: xlib::Atom,
    targets: xlib::Atom,
    timestamp: xlib::Atom,
    incr: xlib::Atom,
    property: xlib::Atom,
    owned_since: xlib::Time,
    values: HashMap<xlib::Atom, Value>,
    outgoing: HashMap<(xlib::Window, xlib::Atom), Outgoing>,
    registry: Vec<xlib::Atom>,
    generation: u64,
    saved: Option<Saved>,
    monitor: generation::Monitor,
    #[cfg(test)]
    requests: Vec<(Instant, String, xlib::Window)>,
}

impl Owner {
    pub fn open() -> Result<Self, String> {
        let connection = Connection::open()?;
        let window = unsafe {
            (connection.api.XCreateSimpleWindow)(
                connection.display,
                connection.root,
                0,
                0,
                1,
                1,
                0,
                0,
                0,
            )
        };
        unsafe {
            (connection.api.XSelectInput)(connection.display, window, xlib::PropertyChangeMask);
        }
        let clipboard = connection.atom("CLIPBOARD")?;
        let targets = connection.atom("TARGETS")?;
        let timestamp = connection.atom("TIMESTAMP")?;
        let incr = connection.atom("INCR")?;
        let property = connection.atom("_FLOWMIC_SELECTION_TRANSFER")?;
        connection.sync()?;
        let monitor = generation::Monitor::new(&connection, window, clipboard)?;
        Ok(Self {
            connection,
            window,
            clipboard,
            targets,
            timestamp,
            incr,
            property,
            owned_since: 0,
            values: HashMap::new(),
            outgoing: HashMap::new(),
            registry: Vec::new(),
            generation: 0,
            saved: None,
            monitor,
            #[cfg(test)]
            requests: Vec::new(),
        })
    }

    fn owner(&self) -> xlib::Window {
        unsafe { (self.connection.api.XGetSelectionOwner)(self.connection.display, self.clipboard) }
    }

    fn matches_owner(&self, owner: xlib::Window, generation: u64) -> bool {
        self.owner() == owner && self.generation == generation
    }

    fn id(&mut self, atom: xlib::Atom) -> Result<u32, String> {
        let index = if let Some(index) = self.registry.iter().position(|a| *a == atom) {
            index
        } else {
            self.registry.push(atom);
            self.registry.len() - 1
        };
        if index >= 0x7fff_fffe {
            return Err("X11 target registry exhausted".into());
        }
        Ok(0x8000_0000 | index as u32)
    }

    fn name(&self, atom: xlib::Atom) -> String {
        unsafe {
            let pointer = (self.connection.api.XGetAtomName)(self.connection.display, atom);
            if pointer.is_null() {
                return format!("atom-{atom}");
            }
            let name = CStr::from_ptr(pointer).to_string_lossy().into_owned();
            (self.connection.api.XFree)(pointer.cast());
            name
        }
    }

    pub fn save(&mut self) -> Result<ClipboardSnapshot, String> {
        self.pump()?;
        let previous_revision = self.monitor.current(&self.connection)?;
        let previous_owner = self.owner();
        let token = self
            .generation
            .checked_add(1)
            .ok_or("selection generation exhausted")?;
        self.generation = token;
        let mut snapshot = ClipboardSnapshot {
            formats: vec![(TOKEN, token.to_le_bytes().to_vec())],
            skipped: Vec::new(),
        };
        let mut total = 0;
        let mut previous_timestamp = None;
        if previous_owner != 0 {
            let atoms = if previous_owner == self.window {
                self.values.keys().copied().collect()
            } else {
                let list = self.convert(self.targets)?;
                if list.kind != xlib::XA_ATOM {
                    return Err("TARGETS did not return ATOM data".into());
                }
                list.as_words()?
            };
            if atoms.len() > 512 {
                return Err("clipboard offers more than 512 targets".into());
            }
            if previous_owner != self.window && atoms.contains(&self.timestamp) {
                previous_timestamp = Some(self.selection_timestamp()?);
            }
            for atom in atoms {
                let name = self.name(atom);
                if transfer::metadata(&name) {
                    continue;
                }
                let id = self.id(atom)?;
                let value = if !transfer::byte_target(&name) {
                    Err("target is not a safe byte conversion".into())
                } else if previous_owner == self.window {
                    self.values
                        .get(&atom)
                        .cloned()
                        .ok_or_else(|| "owned target missing".into())
                } else {
                    self.convert(atom)
                };
                match value {
                    Ok(value)
                        if !transfer::resource_type(value.kind)
                            && total + value.bytes.len() <= LIMIT =>
                    {
                        total += value.bytes.len();
                        snapshot.formats.push((id, value.encode()));
                    }
                    other => {
                        snapshot.skipped.push(id);
                        let reason = match other {
                            Err(e) => e,
                            Ok(_) => "resource type or aggregate size limit".into(),
                        };
                        crate::forensic::record(
                            "inject",
                            &format!("X11 snapshot skipped target={name} id={id}: {reason}"),
                        );
                    }
                }
                if self.owner() != previous_owner
                    || self.monitor.current(&self.connection)? != previous_revision
                {
                    return Err(
                        "clipboard owner changed during snapshot; no replacement performed".into(),
                    );
                }
            }
        }
        if let Some(stamp) = &previous_timestamp {
            if self.selection_timestamp()? != *stamp {
                return Err("clipboard TIMESTAMP changed during snapshot".into());
            }
        }
        if self.monitor.current(&self.connection)? != previous_revision {
            return Err("clipboard generation changed during snapshot".into());
        }
        self.saved = Some(Saved {
            token,
            previous_owner,
            previous_revision,
            previous_timestamp,
            replacement_generation: None,
        });
        Ok(snapshot)
    }

    pub fn restore(&mut self, snapshot: ClipboardSnapshot) -> Result<(), String> {
        self.pump()?;
        let token = snapshot
            .formats
            .iter()
            .find(|(id, _)| *id == TOKEN)
            .and_then(|(_, b)| b.as_slice().try_into().ok())
            .map(u64::from_le_bytes)
            .ok_or("snapshot has no Linux transaction token")?;
        let saved = self
            .saved
            .take()
            .ok_or("no saved Linux clipboard transaction")?;
        if saved.token != token {
            self.saved = Some(saved);
            return Err("stale Linux clipboard transaction".into());
        }
        let Some((generation, revision)) = saved.replacement_generation else {
            // No replacement occurred, or a deliberate native copy superseded it.
            crate::forensic::record(
                "inject",
                "X11 restore: transaction never replaced clipboard; preserved current owner",
            );
            return Ok(());
        };
        if !self.matches_owner(self.window, generation)
            || self.monitor.current(&self.connection)? != revision
        {
            crate::forensic::record("inject", "X11 restore: a newer clipboard owner/generation superseded paste; preserved user copy");
            return Ok(());
        }
        let mut values = HashMap::new();
        for (id, bytes) in snapshot.formats {
            if id == TOKEN {
                continue;
            }
            if id & 0x8000_0000 == 0 {
                return Err("Win32 id in Linux clipboard snapshot".into());
            }
            let atom = self
                .registry
                .get((id & 0x7fff_ffff) as usize)
                .ok_or("unknown Linux clipboard target id")?;
            values.insert(*atom, Value::decode(&bytes)?);
        }
        if !self.publish(values, Some((self.window, generation, revision)))? {
            crate::forensic::record(
                "inject",
                "X11 restore: newer owner won before replacement; preserved user copy",
            );
        }
        Ok(())
    }

    pub fn write_text(&mut self, text: &str) -> Result<(), String> {
        let values = self.text_values(text)?;
        self.publish(values, None)?;
        // A user copy is a new generation, even though its XID is the same
        // service window. The old injection's restore must leave it intact.
        if let Some(saved) = self.saved.as_mut() {
            saved.replacement_generation = None;
        }
        Ok(())
    }

    pub fn begin_paste(&mut self, text: &str) -> Result<(), String> {
        self.pump()?;
        let saved = self
            .saved
            .as_ref()
            .ok_or("paste requires a completed clipboard snapshot")?;
        if self.owner() != saved.previous_owner {
            return Err("clipboard owner changed before paste; no replacement performed".into());
        }
        let previous_owner = saved.previous_owner;
        let previous_revision = saved.previous_revision;
        if let Some(stamp) = saved.previous_timestamp.clone() {
            if self.selection_timestamp()? != stamp {
                return Err("clipboard TIMESTAMP changed before replacement".into());
            }
        }
        let values = self.text_values(text)?;
        if !self.publish(
            values,
            Some((previous_owner, self.generation, previous_revision)),
        )? {
            return Err("clipboard owner changed before replacement; no keys sent".into());
        }
        self.saved
            .as_mut()
            .expect("saved transaction")
            .replacement_generation =
            Some((self.generation, self.monitor.current(&self.connection)?));
        Ok(())
    }

    fn selection_timestamp(&mut self) -> Result<Vec<u8>, String> {
        let value = self.convert(self.timestamp)?;
        if value.kind != xlib::XA_INTEGER || value.width != 32 || value.bytes.len() != 4 {
            return Err("TIMESTAMP was not one INTEGER/32 value".into());
        }
        Ok(value.bytes)
    }

    fn text_values(&self, text: &str) -> Result<HashMap<xlib::Atom, Value>, String> {
        if text.len() > LIMIT {
            return Err("clipboard text exceeds 64 MiB".into());
        }
        let utf8 = self.connection.atom("UTF8_STRING")?;
        let mut values = HashMap::new();
        for name in [
            "UTF8_STRING",
            "text/plain;charset=utf-8",
            "text/plain",
            "TEXT",
        ] {
            values.insert(
                self.connection.atom(name)?,
                Value {
                    kind: utf8,
                    width: 8,
                    bytes: text.as_bytes().to_vec(),
                },
            );
        }
        if text.chars().all(|c| c as u32 <= 255) {
            values.insert(
                xlib::XA_STRING,
                Value {
                    kind: xlib::XA_STRING,
                    width: 8,
                    bytes: text.chars().map(|c| c as u8).collect(),
                },
            );
        }
        Ok(values)
    }

    fn publish(
        &mut self,
        values: HashMap<xlib::Atom, Value>,
        expected: Option<(xlib::Window, u64, u64)>,
    ) -> Result<bool, String> {
        // Drain old property events before obtaining this ownership timestamp.
        // Requests are served by our loop throughout the timestamp wait.
        self.pump()?;
        unsafe {
            (self.connection.api.XChangeProperty)(
                self.connection.display,
                self.window,
                self.property,
                xlib::XA_INTEGER,
                8,
                xlib::PropModeAppend,
                std::ptr::null(),
                0,
            );
        }
        self.connection.sync()?;
        let deadline = Instant::now() + DEADLINE;
        let time = loop {
            if let Some(event) = self.next_event()? {
                if event.get_type() == xlib::PropertyNotify
                    && unsafe {
                        event.property.window == self.window
                            && event.property.atom == self.property
                            && event.property.state == xlib::PropertyNewValue
                    }
                {
                    break unsafe { event.property.time };
                }
                self.event(event)?;
            }
            if Instant::now() >= deadline {
                return Err("X11 ownership timestamp timed out".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        // Check-and-replace under one server grab: a user copy between the
        // caller's initial check and this write must not be overwritten.
        unsafe {
            (self.connection.api.XGrabServer)(self.connection.display);
        }
        struct Ungrab<'a>(&'a Connection);
        impl Drop for Ungrab<'_> {
            fn drop(&mut self) {
                unsafe {
                    (self.0.api.XUngrabServer)(self.0.display);
                    (self.0.api.XFlush)(self.0.display);
                }
            }
        }
        let _ungrab = Ungrab(&self.connection);
        if let Some((owner, generation, revision)) = expected {
            if self.monitor.current(&self.connection)? != revision
                || !self.matches_owner(owner, generation)
            {
                return Ok(false);
            }
        }
        unsafe {
            (self.connection.api.XSetSelectionOwner)(
                self.connection.display,
                self.clipboard,
                self.window,
                time,
            );
        }
        self.connection.sync()?;
        if self.owner() != self.window {
            return Err("XSetSelectionOwner read-back refused ownership".into());
        }
        self.values = values;
        self.owned_since = time;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or("selection generation exhausted")?;
        Ok(true)
    }

    fn next_event(&self) -> Result<Option<xlib::XEvent>, String> {
        if unsafe { (self.connection.api.XPending)(self.connection.display) } == 0 {
            return Ok(None);
        }
        let mut event = unsafe { std::mem::zeroed() };
        unsafe {
            (self.connection.api.XNextEvent)(self.connection.display, &mut event);
        }
        self.connection.sync()?;
        Ok(Some(event))
    }

    pub fn pump(&mut self) -> Result<(), String> {
        while let Some(event) = self.next_event()? {
            self.event(event)?;
        }
        let now = Instant::now();
        self.outgoing.retain(|(window, property), transfer| {
            if transfer.deadline > now {
                true
            } else {
                crate::forensic::record(
                    "inject",
                    &format!("X11 outgoing INCR timed out requestor={window} property={property}"),
                );
                false
            }
        });
        Ok(())
    }

    fn event(&mut self, event: xlib::XEvent) -> Result<(), String> {
        if self.monitor.event(&event) {
            return Ok(());
        }
        unsafe {
            match event.get_type() {
                xlib::SelectionRequest => self.serve(event.selection_request),
                xlib::SelectionClear => {
                    // Keep in-flight transfer values: a request already accepted
                    // still gets its original bytes, even after restoration.
                    self.generation = self.generation.saturating_add(1);
                    Ok(())
                }
                xlib::PropertyNotify if event.property.state == xlib::PropertyDelete => {
                    let key = (event.property.window, event.property.atom);
                    if let Some(mut send) = self.outgoing.remove(&key) {
                        let end = (send.offset + CHUNK).min(send.value.bytes.len());
                        let chunk = Value {
                            kind: send.value.kind,
                            width: send.value.width,
                            bytes: send.value.bytes[send.offset..end].to_vec(),
                        };
                        transfer::write(&self.connection, key.0, key.1, &chunk)?;
                        if send.offset < send.value.bytes.len() {
                            send.offset = end;
                            send.deadline = Instant::now() + DEADLINE;
                            self.outgoing.insert(key, send);
                        }
                    }
                    Ok(())
                }
                _ => Ok(()),
            }
        }
    }

    fn serve(&mut self, request: xlib::XSelectionRequestEvent) -> Result<(), String> {
        #[cfg(test)]
        self.requests.push((Instant::now(), self.name(request.target), request.requestor));
        let property = if request.property == 0 {
            request.target
        } else {
            request.property
        };
        let value = if request.selection != self.clipboard || self.owner() != self.window {
            None
        } else if request.target == self.targets {
            let mut targets: Vec<_> = self.values.keys().copied().collect();
            targets.extend([self.targets, self.timestamp]);
            Some(Value::words(xlib::XA_ATOM, &targets))
        } else if request.target == self.timestamp {
            Some(Value::words(xlib::XA_INTEGER, &[self.owned_since]))
        } else {
            self.values.get(&request.target).cloned()
        };
        let mut accepted = false;
        if let Some(value) = value {
            let result = if value.bytes.len() <= CHUNK {
                transfer::write(&self.connection, request.requestor, property, &value)
            } else if self.outgoing.len() >= 16 {
                Err("too many concurrent INCR consumers".into())
            } else {
                unsafe {
                    (self.connection.api.XSelectInput)(
                        self.connection.display,
                        request.requestor,
                        xlib::PropertyChangeMask,
                    );
                }
                transfer::write(
                    &self.connection,
                    request.requestor,
                    property,
                    &Value::words(self.incr, &[value.bytes.len() as _]),
                )
                .map(|()| {
                    self.outgoing.insert(
                        (request.requestor, property),
                        Outgoing {
                            value,
                            offset: 0,
                            deadline: Instant::now() + DEADLINE,
                        },
                    );
                })
            };
            match result {
                Ok(()) => accepted = true,
                Err(e) => {
                    crate::forensic::record("inject", &format!("X11 selection serve failed: {e}"))
                }
            }
        }
        let mut event: xlib::XEvent = unsafe { std::mem::zeroed() };
        event.selection = xlib::XSelectionEvent {
            type_: xlib::SelectionNotify,
            serial: 0,
            send_event: 1,
            display: self.connection.display,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property: if accepted { property } else { 0 },
            time: request.time,
        };
        unsafe {
            (self.connection.api.XSendEvent)(
                self.connection.display,
                request.requestor,
                0,
                0,
                &mut event,
            );
        }
        self.connection.sync()
    }

    fn convert(&mut self, target: xlib::Atom) -> Result<Value, String> {
        unsafe {
            (self.connection.api.XDeleteProperty)(
                self.connection.display,
                self.window,
                self.property,
            );
            (self.connection.api.XConvertSelection)(
                self.connection.display,
                self.clipboard,
                target,
                self.property,
                self.window,
                xlib::CurrentTime,
            );
        }
        self.connection.sync()?;
        let deadline = Instant::now() + DEADLINE;
        loop {
            if let Some(event) = self.next_event()? {
                if event.get_type() == xlib::SelectionNotify
                    && unsafe {
                        event.selection.requestor == self.window && event.selection.target == target
                    }
                {
                    if unsafe { event.selection.property } == 0 {
                        return Err("selection owner refused conversion".into());
                    }
                    break;
                }
                self.event(event)?;
            }
            if Instant::now() >= deadline {
                return Err("selection conversion timed out".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let value = transfer::read(&self.connection, self.window, self.property)?;
        if value.kind != self.incr {
            unsafe {
                (self.connection.api.XDeleteProperty)(
                    self.connection.display,
                    self.window,
                    self.property,
                );
            }
            return Ok(value);
        }
        let advertised = value
            .as_words()?
            .first()
            .copied()
            .ok_or("INCR has no size")?;
        if advertised as usize > LIMIT {
            return Err("INCR advertisement exceeds 64 MiB".into());
        }
        unsafe {
            (self.connection.api.XDeleteProperty)(
                self.connection.display,
                self.window,
                self.property,
            );
        }
        self.connection.sync()?;
        let mut received: Option<Value> = None;
        loop {
            if let Some(event) = self.next_event()? {
                if event.get_type() == xlib::PropertyNotify
                    && unsafe {
                        event.property.window == self.window
                            && event.property.atom == self.property
                            && event.property.state == xlib::PropertyNewValue
                    }
                {
                    let chunk = transfer::read(&self.connection, self.window, self.property)?;
                    unsafe {
                        (self.connection.api.XDeleteProperty)(
                            self.connection.display,
                            self.window,
                            self.property,
                        );
                    }
                    self.connection.sync()?;
                    let empty = chunk.bytes.is_empty();
                    if let Some(value) = &mut received {
                        if value.kind != chunk.kind || value.width != chunk.width {
                            return Err("INCR changed property type/format mid-transfer".into());
                        }
                        if value.bytes.len() + chunk.bytes.len() > LIMIT {
                            return Err("INCR total exceeds 64 MiB".into());
                        }
                        value.bytes.extend(chunk.bytes);
                    } else {
                        received = Some(chunk);
                    }
                    if empty {
                        return received.ok_or_else(|| "empty INCR transfer".into());
                    }
                } else {
                    self.event(event)?;
                }
            }
            if Instant::now() >= deadline {
                return Err("INCR receive timed out; snapshot incomplete".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            (self.connection.api.XDestroyWindow)(self.connection.display, self.window);
        }
    }
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;

#[path = "paste.rs"]
mod paste;

#[cfg(test)]
#[path = "native_tests.rs"]
mod native_tests;
