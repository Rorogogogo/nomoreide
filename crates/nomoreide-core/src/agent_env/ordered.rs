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

    /// Replace the value at `key`, keeping its place, or append it.
    pub fn set(&mut self, key: String, value: T) {
        match self.0.iter_mut().find(|(candidate, _)| *candidate == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }

    /// Remove `key`, returning whether it was there. Everything else keeps
    /// the order it had.
    pub fn remove(&mut self, key: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|(candidate, _)| candidate != key);
        self.0.len() != before
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.0.iter().any(|(candidate, _)| candidate == key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        self.0
            .iter_mut()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value)
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

/// A JSON document that keeps every object's key order, at every depth.
///
/// `serde_json::Value` cannot be edited and written back here: its objects are
/// sorted, so re-saving a user's config would silently rearrange a file they
/// wrote by hand. This carries the same shapes with [`OrderedMap`] underneath,
/// which is what makes an edit touch only the entry it was asked to touch.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(OrderedMap<Json>),
}

impl Json {
    pub fn object() -> Self {
        Self::Object(OrderedMap::new())
    }

    pub fn as_object(&self) -> Option<&OrderedMap<Json>> {
        match self {
            Self::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut OrderedMap<Json>> {
        match self {
            Self::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    /// The entry at `key`, creating an empty object there when the key is
    /// absent or holds something that is not an object.
    pub fn object_at(&mut self, key: &str) -> &mut OrderedMap<Json> {
        let map = match self {
            Self::Object(map) => map,
            other => {
                *other = Self::object();
                other.as_object_mut().expect("just replaced with an object")
            }
        };
        if !matches!(map.get(key), Some(Json::Object(_))) {
            map.set(key.to_string(), Json::object());
        }
        map.get_mut(key)
            .and_then(Json::as_object_mut)
            .expect("just ensured an object is there")
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(value) => value.serialize(serializer),
            Self::String(value) => serializer.serialize_str(value),
            Self::Array(values) => values.serialize(serializer),
            Self::Object(map) => map.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct AnyJson;

        impl<'de> Visitor<'de> for AnyJson {
            type Value = Json;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("any JSON value")
            }

            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Json, D::Error> {
                Json::deserialize(d)
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Json, E> {
                Ok(serde_json::Number::from_f64(value)
                    .map(Json::Number)
                    .unwrap_or(Json::Null))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::String(value.to_string()))
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::String(value))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut access: A,
            ) -> Result<Json, A::Error> {
                let mut values = Vec::with_capacity(access.size_hint().unwrap_or(0));
                while let Some(value) = access.next_element()? {
                    values.push(value);
                }
                Ok(Json::Array(values))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Json, A::Error> {
                let mut map = OrderedMap::new();
                while let Some((key, value)) = access.next_entry::<String, Json>()? {
                    map.insert(key, value);
                }
                Ok(Json::Object(map))
            }
        }

        deserializer.deserialize_any(AnyJson)
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
    fn an_edit_leaves_every_other_key_where_it_was() {
        let mut map: OrderedMap<Value> = serde_json::from_str(r#"{"a":1,"b":2,"c":3}"#).unwrap();
        map.set("b".into(), Value::from(9));
        map.set("d".into(), Value::from(4));
        assert!(map.remove("a"));
        assert!(!map.remove("a"));
        assert_eq!(
            serde_json::to_string(&map).unwrap(),
            r#"{"b":9,"c":3,"d":4}"#
        );
    }

    #[test]
    fn a_document_keeps_its_order_at_every_depth() {
        let source = r#"{"z":{"inner":{"q":1,"a":2}},"a":[{"y":true,"b":null}],"n":1.5}"#;
        let document: Json = serde_json::from_str(source).unwrap();
        assert_eq!(serde_json::to_string(&document).unwrap(), source);
    }

    #[test]
    fn an_empty_map_is_still_an_object() {
        let map = OrderedMap::<Value>::new();
        assert!(map.is_empty());
        assert_eq!(serde_json::to_string(&map).unwrap(), "{}");
    }
}
