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
fn world(object: &Value, point: Point, pivot: Point) -> Point {
    let turned = rotate(
        (point.0 - pivot.0, point.1 - pivot.1),
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
                    .filter(|o| o["shape"]["type"] == "symbol")
                    .ok_or("同一画面の接続先Symbol配置が見つかりません")?;
                let (width, height) = (number(target, "width"), number(target, "height"));
                let anchor = match connection["anchor"].as_str().unwrap() {
                    "top" => (width / 2.0, 0.0),
                    "right" => (width, height / 2.0),
                    "bottom" => (width / 2.0, height),
                    "left" => (0.0, height / 2.0),
                    "center" => (width / 2.0, height / 2.0),
                    _ => unreachable!("schema validated anchor"),
                };
                let expected = world(target, anchor, (width / 2.0, height / 2.0));
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
