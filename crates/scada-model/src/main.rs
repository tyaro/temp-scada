use scada_model::Project;
use std::{env, fs, process::ExitCode};
fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 || args[1] != "validate" {
        eprintln!("Usage: scada-model validate <project.json>");
        return ExitCode::FAILURE;
    }
    match fs::read_to_string(&args[2])
        .map_err(|e| e.to_string())
        .and_then(|s| Project::from_json(&s))
    {
        Ok(_) => {
            println!("Project is valid");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Invalid project: {e}");
            ExitCode::FAILURE
        }
    }
}
