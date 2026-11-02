use super::Project;
use serde_json::{json, Value};

#[test]
fn shared_project_trend_contract_and_round_trip() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../examples/trend-placement-cases.json")).unwrap();
    let base: Value =
        serde_json::from_str(include_str!("../../../examples/trend.project.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let mut project = base.clone();
        for op in case["ops"].as_array().into_iter().flatten() {
            let (parent, key) = op["path"].as_str().unwrap().rsplit_once('/').unwrap();
            let owner = project.pointer_mut(parent).unwrap();
            if owner.is_array() {
                owner[key.parse::<usize>().unwrap()] = op["value"].clone();
            } else {
                owner[key] = op["value"].clone();
            }
        }
        if case["removeCard"] == true {
            project["screens"][0]["objects"]
                .as_array_mut()
                .unwrap()
                .pop();
        }
        if case["omitTrends"] == true {
            project.as_object_mut().unwrap().remove("trends");
        }
        if case["symbolTrend"] == true {
            let mut card = project["screens"][0]["objects"][3].clone();
            card["id"] = json!("0199f000-0000-7000-8000-000000000042");
            project["symbols"].as_array_mut().unwrap().push(json!({"id":"0199f000-0000-7000-8000-000000000041","name":"禁止Symbol","width":320,"height":120,"folders":[],"objects":[card]}));
        }
        if case["oversize"] == true {
            let row = project["trends"][0].clone();
            project["trends"]=Value::Array((0..128).map(|i| {
                let mut row=row.clone();row["id"]=json!(format!("trend:{i}"));row["name"]=json!("😀".repeat(512));row["maxPointsPerSeries"]=json!(1000);
                row["pens"]=Value::Array((0..8).map(|j|json!({"id":format!("pen:{j}"),"seriesId":format!("series:{j}"),"color":"#123456","label":"😀".repeat(512)})).collect());row
            }).collect());
            project["screens"][0]["objects"][3]["shape"]["trendId"] = json!("trend:0");
        }
        let parsed = Project::from_json(&serde_json::to_string(&project).unwrap());
        assert_eq!(
            parsed.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}: {:?}",
            case["name"],
            parsed.err()
        );
        if let Ok(parsed) = Project::from_json(&serde_json::to_string(&project).unwrap()) {
            let round = Project::from_json(&parsed.to_json()).unwrap();
            assert_eq!(parsed, round);
        }
    }
}
