//! The menu-bar icon, drawn from the logo's geometry.
//!
//! `assets/nomoreide-favicon.svg` on its 64-unit grid: a folder whose body
//! runs 5..59 × 17..59 with 6-unit corners and a tab up to y 11, holding a
//! `>_` prompt. The menu-bar version is the folder in solid black with the
//! prompt cut out, as a template image so macOS tints it for light and dark
//! menu bars. Drawn rather than shipped as a PNG because a template needs
//! alpha only, and this keeps it sharp at exactly the size the menu bar uses.

use tray_icon::Icon;

fn in_rounded_corner(x: f32, y: f32, cx: f32, cy: f32, r: f32) -> bool {
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

/// The folder silhouette.
pub(super) fn in_folder(x: f32, y: f32) -> bool {
    const R: f32 = 6.0;
    // The tab: from x 5 to a slanted edge running (25, 11) → (31, 17), with
    // the folder's top-left corner rounded about (11, 17).
    if (11.0..17.0).contains(&y) {
        if x < 5.0 || x > 25.0 + (y - 11.0) {
            return false;
        }
        return x >= 11.0 || in_rounded_corner(x, y, 11.0, 17.0, R);
    }
    if !(5.0..=59.0).contains(&x) || !(17.0..=59.0).contains(&y) {
        return false;
    }
    // The body's other three corners.
    if x > 53.0 && y < 23.0 {
        return in_rounded_corner(x, y, 53.0, 23.0, R);
    }
    if x > 53.0 && y > 53.0 {
        return in_rounded_corner(x, y, 53.0, 53.0, R);
    }
    if x < 11.0 && y > 53.0 {
        return in_rounded_corner(x, y, 11.0, 53.0, R);
    }
    true
}

fn distance_to_segment(x: f32, y: f32, (ax, ay): (f32, f32), (bx, by): (f32, f32)) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let t = (((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    ((x - ax - t * dx).powi(2) + (y - ay - t * dy).powi(2)).sqrt()
}

/// The `>_` prompt: a round-capped chevron and a square-capped underscore,
/// both 4.5 units wide.
pub(super) fn in_prompt(x: f32, y: f32) -> bool {
    const HALF: f32 = 2.25;
    let chevron = distance_to_segment(x, y, (22.0, 31.0), (30.0, 39.0)) <= HALF
        || distance_to_segment(x, y, (30.0, 39.0), (22.0, 47.0)) <= HALF;
    let underscore = (36.0 - HALF..=48.0 + HALF).contains(&x) && (y - 47.0).abs() <= HALF;
    chevron || underscore
}

/// Share of the pixel at (px, py) that `inside` covers, 4×4 samples.
fn coverage(px: u32, py: u32, inside: impl Fn(f32, f32) -> bool) -> f32 {
    const SS: u32 = 4;
    let mut hit = 0;
    for sy in 0..SS {
        for sx in 0..SS {
            let x = px as f32 + (sx as f32 + 0.5) / SS as f32;
            let y = py as f32 + (sy as f32 + 0.5) / SS as f32;
            hit += inside(x, y) as u32;
        }
    }
    hit as f32 / (SS * SS) as f32
}

/// The template icon's alpha, `N`×`N` RGBA.
pub(super) fn template_rgba(n: u32) -> Vec<u8> {
    // The logo is 54 units wide (5..59) and 48 tall (11..59); fit the width
    // into all but a 2px margin each side, centred on the folder's middle.
    let scale = (n as f32 - 4.0) / 54.0;
    let half = n as f32 / 2.0;
    let to_grid = |px: f32, centre: f32| (px - half) / scale + centre;
    let mut rgba = Vec::with_capacity((n * n * 4) as usize);
    for py in 0..n {
        for px in 0..n {
            let alpha = coverage(px, py, |x, y| {
                let (gx, gy) = (to_grid(x, 32.0), to_grid(y, 35.0));
                in_folder(gx, gy) && !in_prompt(gx, gy)
            });
            rgba.extend_from_slice(&[0, 0, 0, (alpha * 255.0) as u8]);
        }
    }
    rgba
}

pub(super) fn tray_icon() -> Icon {
    // 18pt at 2x: the menu-bar height macOS draws template icons at.
    const N: u32 = 36;
    Icon::from_rgba(template_rgba(N), N, N).expect("a square RGBA buffer is a valid icon")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_matches_the_logo() {
        assert!(in_folder(32.0, 40.0), "the body");
        assert!(in_folder(15.0, 14.0), "the tab");
        assert!(!in_folder(40.0, 14.0), "beside the tab");
        assert!(!in_folder(5.5, 11.5), "the tab's rounded corner");
        assert!(!in_folder(58.8, 58.8), "the body's rounded corner");
    }

    #[test]
    fn the_prompt_is_cut_out() {
        assert!(in_prompt(30.0, 39.0), "the chevron's point");
        assert!(in_prompt(42.0, 47.0), "the underscore");
        assert!(!in_prompt(40.0, 30.0), "empty folder");
    }

    #[test]
    fn the_icon_has_ink_and_holes() {
        let rgba = template_rgba(36);
        assert_eq!(rgba.len(), 36 * 36 * 4);
        let alphas: Vec<u8> = rgba.chunks(4).map(|px| px[3]).collect();
        assert!(alphas.contains(&255), "solid folder");
        assert!(alphas.contains(&0), "transparent background");
        // The middle of the chevron is transparent inside an opaque folder.
        let to_px = |g: f32, centre: f32| ((g - centre) * 32.0 / 54.0 + 18.0) as usize;
        let (px, py) = (to_px(26.0, 32.0), to_px(35.0, 35.0));
        assert!(alphas[py * 36 + px] < 128, "the prompt shows through");
    }
}
