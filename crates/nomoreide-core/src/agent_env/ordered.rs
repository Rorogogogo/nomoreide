//! A JSON object that keeps the order its source file wrote it in.
//!
//! Every MCP server map an agent config holds is reported in *file* order, not
//! sorted — a server added last is still listed last. `serde_json::Map` cannot
//! carry that here: without the `preserve_order` feature it is a `BTreeMap`,
//! and turning that feature on would silently reorder every other map this
//! workspace parses and re-emits. So the ordering lives in this one type
//! instead, which both reads and writes entries in the order it met them.

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::marker::PhantomData;

#[derive(Debug, Clone, PartialEq)]
pub struct OrderedMap<T>(Vec<(String, T)>);

impl<T> Default for OrderedMap<T> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<T> OrderedMap<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: String, value: T) {
        self.0.push((key, value));
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &T)> {
        self.0.iter().map(|(key, value)| (key.as_str(), value))
    }

    pub fn get(&self, key: &str) -> Option<&T> {
        self.0
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value)
    }
}

impl<T> IntoIterator for OrderedMap<T> {
    type Item = (String, T);
    type IntoIter = std::vec::IntoIter<(String, T)>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl<T: Serialize> Serialize for OrderedMap<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for OrderedMap<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InOrder<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for InOrder<T> {
            type Value = OrderedMap<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::with_capacity(access.size_hint().unwrap_or(0));
                // A deserializer hands entries over in document order, so
                // collecting them into a `Vec` is what keeps that order.
                while let Some((key, value)) = access.next_entry::<String, T>()? {
                    entries.push((key, value));
                }
                Ok(OrderedMap(entries))
            }
        }

        deserializer.deserialize_map(InOrder(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn a_map_survives_a_round_trip_in_the_order_it_was_written() {
        let source = r#"{"zulu":1,"alpha":2,"mike":3}"#;
        let map: OrderedMap<Value> = serde_json::from_str(source).unwrap();
        assert_eq!(
            map.iter().map(|(key, _)| key).collect::<Vec<_>>(),
            ["zulu", "alpha", "mike"]
        );
        assert_eq!(serde_json::to_string(&map).unwrap(), source);
    }

    #[test]
    fn an_empty_map_is_still_an_object() {
        let map = OrderedMap::<Value>::new();
        assert!(map.is_empty());
        assert_eq!(serde_json::to_string(&map).unwrap(), "{}");
    }
}
