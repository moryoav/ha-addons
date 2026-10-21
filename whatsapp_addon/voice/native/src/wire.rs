use anyhow::{Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::BTreeMap;
use whatsapp_rust::wacore_binary::{
    Node, NodeContent, OwnedNodeRef, builder::NodeBuilder, encoder::Encoder,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireNode {
    pub tag: String,
    pub attrs: BTreeMap<String, String>,
    #[serde(default)]
    pub content: Value,
}

impl WireNode {
    pub fn to_node(&self) -> Result<Node> {
        self.convert(0, &mut 0)
    }
    fn convert(&self, depth: usize, count: &mut usize) -> Result<Node> {
        *count += 1;
        if depth > 16 || *count > 1024 || self.tag.is_empty() || self.tag.len() > 80 {
            bail!("invalid_node");
        }
        let mut builder = NodeBuilder::new_dynamic(self.tag.clone());
        for (key, value) in &self.attrs {
            if key.len() > 80 || value.len() > 4096 {
                bail!("invalid_attribute");
            }
        }
        if let Some(children) = self.content.as_array() {
            let nodes = children
                .iter()
                .map(|value| {
                    serde_json::from_value::<WireNode>(value.clone())?.convert(depth + 1, count)
                })
                .collect::<Result<Vec<_>>>()?;
            builder = builder.children(nodes);
        } else if !self.content.is_null() {
            let data = self
                .content
                .get("bytes")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("invalid_content"))?;
            builder = builder.bytes(decode_bytes(data, 256 * 1024)?);
        }
        let mut node = builder.build();
        for (key, value) in &self.attrs {
            node.attrs.insert(Cow::Owned(key.clone()), value.clone());
        }
        Ok(node)
    }
    pub fn owned(&self) -> Result<OwnedNodeRef> {
        let node = self.to_node()?;
        let mut bytes = Vec::new();
        Encoder::new_vec(&mut bytes)?.write_node(&node)?;
        Ok(OwnedNodeRef::new(
            whatsapp_rust::wacore_binary::util::unpack(&bytes)?.into_owned(),
        )?)
    }
    pub fn from_node(node: &Node) -> Self {
        Self {
            tag: node.tag.to_string(),
            attrs: node
                .attrs
                .iter()
                .map(|(key, value)| (key.to_string(), value.as_str().to_string()))
                .collect(),
            content: match node.content.as_ref() {
                Some(NodeContent::Bytes(bytes)) => json!({"bytes": STANDARD.encode(bytes)}),
                Some(NodeContent::Nodes(children)) => {
                    json!(children.iter().map(Self::from_node).collect::<Vec<_>>())
                }
                None => Value::Null,
                _ => Value::Null,
            },
        }
    }
}

pub fn decode_bytes(value: &str, max: usize) -> Result<Vec<u8>> {
    if value.len() > max.div_ceil(3) * 4 {
        bail!("bytes_too_large");
    }
    let bytes = STANDARD.decode(value)?;
    if bytes.len() > max {
        bail!("bytes_too_large");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_nodes_round_trip_without_losing_zeroes_or_jids() {
        let wire: WireNode = serde_json::from_value(json!({"tag":"call", "attrs":{"from":"111111111:7@lid"}, "content":[{"tag":"enc", "attrs":{"v":"2"}, "content":{"bytes":"AAEC/w=="}}]})).unwrap();
        let restored = WireNode::from_node(&wire.to_node().unwrap());
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            serde_json::to_value(&wire).unwrap()
        );
        assert_eq!(wire.owned().unwrap().tag(), "call");
    }
    #[test]
    fn invalid_binary_and_oversize_content_are_rejected() {
        assert!(decode_bytes("!", 32).is_err());
        assert!(decode_bytes(&STANDARD.encode([0; 33]), 32).is_err());
    }
}
