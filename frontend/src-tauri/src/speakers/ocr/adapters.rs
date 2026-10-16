// frontend/src-tauri/src/speakers/ocr/adapters.rs

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedRegion {
    pub x: f32,      // 0.0 to 1.0 (relative to window width)
    pub y: f32,      // 0.0 to 1.0 (relative to window height)
    pub width: f32,  // 0.0 to 1.0
    pub height: f32, // 0.0 to 1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppAdapter {
    pub app_name: String,
    pub process_names: Vec<String>,
    pub window_title_patterns: Vec<String>,
    pub regions_of_interest: Vec<NormalizedRegion>,
    pub strip_tokens: Vec<String>,
}

impl AppAdapter {
    /// Microsoft Teams meeting window layout adapter
    pub fn teams() -> Self {
        Self {
            app_name: "Microsoft Teams".to_string(),
            process_names: vec!["ms-teams.exe".to_string(), "Teams.exe".to_string(), "teams".to_string()],
            window_title_patterns: vec!["| Microsoft Teams".to_string(), "Teams Meeting".to_string()],
            regions_of_interest: vec![
                // Bottom-left tile name tag
                NormalizedRegion { x: 0.02, y: 0.85, width: 0.35, height: 0.12 },
                // Active speaker header / top bar
                NormalizedRegion { x: 0.05, y: 0.02, width: 0.40, height: 0.08 },
            ],
            strip_tokens: vec![
                "(You)".to_string(),
                "(Guest)".to_string(),
                "(External)".to_string(),
                "Presenting".to_string(),
                "Muted".to_string(),
                "Host".to_string(),
            ],
        }
    }

    /// Zoom meeting layout adapter
    pub fn zoom() -> Self {
        Self {
            app_name: "Zoom Workplace".to_string(),
            process_names: vec!["Zoom.exe".to_string(), "zoom.us".to_string(), "zoom".to_string()],
            window_title_patterns: vec!["Zoom Meeting".to_string(), "Zoom Webinar".to_string()],
            regions_of_interest: vec![
                // Bottom-left participant name badge
                NormalizedRegion { x: 0.01, y: 0.88, width: 0.30, height: 0.10 },
                // Speaker view top banner
                NormalizedRegion { x: 0.30, y: 0.02, width: 0.40, height: 0.08 },
            ],
            strip_tokens: vec![
                "(You)".to_string(),
                "(Host)".to_string(),
                "(Co-host)".to_string(),
                "(Me)".to_string(),
                "Talking:".to_string(),
            ],
        }
    }

    /// Google Meet browser window adapter
    pub fn google_meet() -> Self {
        Self {
            app_name: "Google Meet".to_string(),
            process_names: vec!["chrome.exe".to_string(), "msedge.exe".to_string(), "firefox.exe".to_string()],
            window_title_patterns: vec!["Meet - ".to_string(), "Google Meet".to_string()],
            regions_of_interest: vec![
                // Bottom-left tile name chip
                NormalizedRegion { x: 0.02, y: 0.86, width: 0.32, height: 0.10 },
                // Upper right participant indicator
                NormalizedRegion { x: 0.70, y: 0.02, width: 0.28, height: 0.08 },
            ],
            strip_tokens: vec![
                "(You)".to_string(),
                "Presentation".to_string(),
                "Presentation (".to_string(),
                "pin".to_string(),
            ],
        }
    }

    /// Generic fallback scanning the lower third and top corners of participant tiles
    pub fn generic() -> Self {
        Self {
            app_name: "Generic Meeting App".to_string(),
            process_names: vec![],
            window_title_patterns: vec![],
            regions_of_interest: vec![
                NormalizedRegion { x: 0.02, y: 0.80, width: 0.40, height: 0.18 },
                NormalizedRegion { x: 0.50, y: 0.80, width: 0.40, height: 0.18 },
            ],
            strip_tokens: vec!["(You)".to_string(), "(Guest)".to_string(), "Muted".to_string()],
        }
    }

    /// Clean detected OCR text according to app rules
    pub fn clean_text(&self, raw: &str) -> String {
        let mut text = raw.trim().to_string();

        for token in &self.strip_tokens {
            text = text.replace(token, "");
        }

        // Remove extraneous brackets, role markers, and symbols
        text = text
            .lines()
            .next() // Only use the first line of the name badge
            .unwrap_or("")
            .trim()
            .trim_matches(|c: char| !c.is_alphanumeric() && !c.is_whitespace())
            .to_string();

        // Collapse multiple spaces
        let words: Vec<&str> = text.split_whitespace().collect();
        words.join(" ")
    }
}
