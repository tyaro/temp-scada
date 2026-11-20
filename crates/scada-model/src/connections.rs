//! Local drawing references only; no Equipment topology or runtime values.
use serde_json::Value;
use std::collections::HashMap;
const EPSILON: f64 = 1e-7;
type Point = (f64, f64);
fn rotate(point: Point, angle: f64) -> Point {
    let (cos, sin) = match angle {
        0.0 => (1.0, 0.0),
        90.0 => (0.0, 1.0),
        180.0 => (-1.0, 0.0),
        270.0 => (0.0, -1.0),
        _ => {
            let rad = (angle * std::f64::consts::PI) / 180.0;
            (rad.cos(), rad.sin())
        }
    };
    (point.0 * cos - point.1 * sin, point.0 * sin + point.1 * cos)
}
fn number(object: &Value, key: &str) -> f64 {
    object[key].as_f64().unwrap()
}
/// Mirror around the pivot first, then rotate (same order as `rotation.ts`).
fn world(object: &Value, point: Point, pivot: Point) -> Point {
    let sign = |key: &str| {
        if object.get(key) == Some(&Value::Bool(true)) {
            -1.0
        } else {
            1.0
        }
    };
    let turned = rotate(
        (
            (point.0 - pivot.0) * sign("flipX"),
            (point.1 - pivot.1) * sign("flipY"),
        ),
        number(object, "rotation"),
    );
    (
        number(object, "x") + (pivot.0 + turned.0),
        number(object, "y") + (pivot.1 + turned.1),
    )
}
fn finite(point: Point) -> bool {
    point.0.is_finite() && point.1.is_finite()
}
/// 接続先にできる配置の種類（TS の `CONNECTION_TARGET_TYPES` と同じ集合）。
const TARGET_TYPES: [&str; 4] = ["symbol", "rectangle", "ellipse", "polygon"];
fn is_target(object: &Value) -> bool {
    object["shape"]["type"]
        .as_str()
        .is_some_and(|kind| TARGET_TYPES.contains(&kind))
}
/// 多角形の辺の anchor（割合の空間）。TS の `polygonAnchorRatio` と同じ順序・同じ式で、
/// 閉区間を厳密に比べ、許容誤差は使わない。頂点は読込の多角形の検査を通った後に呼ぶ。
fn polygon_anchor_ratio(points: &[Value], anchor: &str) -> Result<Point, String> {
    let vertical = anchor == "top" || anchor == "bottom";
    // 縦の中心線では a = u・b = v、横の中心線では入れ替える。
    let split = |p: &Value| {
        let (u, v) = (number(p, "x"), number(p, "y"));
        if vertical {
            (u, v)
        } else {
            (v, u)
        }
    };
    let mut hits = Vec::new();
    for i in 0..points.len() {
        let (aa, ab) = split(&points[i]);
        let (ba, bb) = split(&points[(i + 1) % points.len()]);
        if !(aa.min(ba) <= 0.5 && 0.5 <= aa.max(ba)) {
            continue;
        }
        if aa == ba {
            hits.push(ab);
            hits.push(bb);
        } else {
            let t = (0.5 - aa) / (ba - aa);
            hits.push(ab + t * (bb - ab));
        }
    }
    let Some(&first) = hits.first() else {
        return Err("多角形の中心線が外周と交わりません".into());
    };
    let value = if anchor == "top" || anchor == "left" {
        hits.iter().copied().fold(first, f64::min)
    } else {
        hits.iter().copied().fold(first, f64::max)
    };
    Ok(if vertical { (0.5, value) } else { (value, 0.5) })
}
/// 接続先の anchor の world 座標（TS の `connectionAnchorPoint`）。
fn anchor_point(target: &Value, anchor: &str) -> Result<Point, String> {
    let (width, height) = (number(target, "width"), number(target, "height"));
    let local = if target["shape"]["type"] == "polygon" && anchor != "center" {
        let ratio = polygon_anchor_ratio(target["shape"]["points"].as_array().unwrap(), anchor)?;
        (ratio.0 * width, ratio.1 * height)
    } else {
        match anchor {
            "top" => (width / 2.0, 0.0),
            "right" => (width, height / 2.0),
            "bottom" => (width / 2.0, height),
            "left" => (0.0, height / 2.0),
            "center" => (width / 2.0, height / 2.0),
            _ => unreachable!("schema validated anchor"),
        }
    };
    Ok(world(target, local, (width / 2.0, height / 2.0)))
}
pub fn validate(project: &Value) -> Result<(), String> {
    for definition in project["symbols"].as_array().unwrap() {
        if definition["objects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["shape"].get("connections").is_some())
        {
            return Err("Symbol定義内の配管接続には対応していません".into());
        }
    }
    for screen in project["screens"].as_array().unwrap() {
        let objects = screen["objects"].as_array().unwrap();
        if !objects
            .iter()
            .any(|o| o["shape"].get("connections").is_some())
        {
            continue;
        }
        let by_id: HashMap<_, _> = objects
            .iter()
            .map(|o| (o["id"].as_str().unwrap(), o))
            .collect();
        for object in objects {
            let Some(connections) = object["shape"].get("connections") else {
                continue;
            };
            if screen["groups"]
                .as_array()
                .unwrap()
                .iter()
                .any(|g| g["memberIds"].as_array().unwrap().contains(&object["id"]))
            {
                return Err("接続中の配管はグループへ入れられません".into());
            }
            let points = object["shape"]["points"].as_array().unwrap();
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            );
            for p in points {
                let (x, y) = (number(p, "x"), number(p, "y"));
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
            let pivot = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
            for p in points {
                if !finite(world(object, (number(p, "x"), number(p, "y")), pivot)) {
                    return Err("接続点には有限の座標が必要です".into());
                }
            }
            for (end, index) in [("start", 0), ("end", points.len() - 1)] {
                let Some(connection) = connections.get(end) else {
                    continue;
                };
                let target = by_id
                    .get(connection["targetObjectId"].as_str().unwrap())
                    .filter(|o| is_target(o))
                    .ok_or("同一画面の接続先（Symbol配置・矩形・楕円・多角形）が見つかりません")?;
                let expected = anchor_point(target, connection["anchor"].as_str().unwrap())?;
                let actual = world(
                    object,
                    (number(&points[index], "x"), number(&points[index], "y")),
                    pivot,
                );
                if !finite(expected)
                    || (actual.0 - expected.0).abs() > EPSILON
                    || (actual.1 - expected.1).abs() > EPSILON
                {
                    return Err("保存された配管端点が接続先の位置と一致していません".into());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::Project;
    use serde_json::Value;
    #[test]
    fn flipped_anchor_world_matches_typescript() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/flip-cases.json")).unwrap();
        let target = &cases["target"];
        for case in cases["anchors"].as_array().unwrap() {
            let mut object = target.clone();
            object["rotation"] = case["rotation"].clone();
            for key in ["flipX", "flipY"] {
                if let Some(flag) = case.get(key) {
                    object[key] = flag.clone();
                }
            }
            let world = super::anchor_point(&object, case["anchor"].as_str().unwrap()).unwrap();
            let expected = (
                super::number(&case["world"], "x"),
                super::number(&case["world"], "y"),
            );
            assert!(
                (world.0 - expected.0).abs() < 1e-9 && (world.1 - expected.1).abs() < 1e-9,
                "{}: {world:?}",
                case["name"]
            );
        }
    }
    #[test]
    fn shares_saved_connection_contract_with_typescript() {
        let sample: Value =
            serde_json::from_str(include_str!("../../../examples/connection.project.json"))
                .unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../examples/connection-cases.json")).unwrap();
        for case in cases {
            let mut project = sample.clone();
            for patch in case["patches"].as_array().unwrap() {
                let path = patch["path"].as_str().unwrap();
                let (parent, key) = path.rsplit_once('/').unwrap();
                let object = project.pointer_mut(parent).unwrap();
                if let Some(index) = object.as_array_mut() {
                    index[key.parse::<usize>().unwrap()] = patch["value"].clone();
                } else {
                    object[key] = patch["value"].clone();
                }
            }
            let result = Project::from_json(&project.to_string());
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {:?}",
                case["name"],
                result.as_ref().err()
            );
            if let Ok(project) = result {
                assert_eq!(
                    Project::from_json(&project.to_json()).unwrap(),
                    project,
                    "{} roundtrip",
                    case["name"]
                );
            }
        }
    }
}
