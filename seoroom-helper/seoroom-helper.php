<?php
/**
 * Plugin Name: SEO Room Helper
 * Description: Registers Yoast SEO meta fields for REST API access + CWV auto-fix via WordPress hooks. Required by SEO Room Dashboard.
 * Version: 2.0.0
 * Author: The SEO Room
 */

if (!defined('ABSPATH')) exit;

add_action('init', function() {
    $post_types = ['page', 'post'];
    $meta_keys = [
        '_yoast_wpseo_title',
        '_yoast_wpseo_metadesc',
        '_yoast_wpseo_focuskw',
        '_yoast_wpseo_linkdex',
        '_yoast_wpseo_content_score',
        '_elementor_data',
        '_elementor_css',
    ];

    foreach ($post_types as $type) {
        foreach ($meta_keys as $key) {
            register_post_meta($type, $key, [
                'show_in_rest'  => true,
                'single'        => true,
                'type'          => 'string',
                'auth_callback' => function() { return current_user_can('edit_posts'); },
            ]);
        }
    }
});

// Also register without underscore prefix (some Yoast versions use both)
add_action('init', function() {
    $post_types = ['page', 'post'];
    $meta_keys = [
        'yoast_wpseo_title',
        'yoast_wpseo_metadesc',
        'yoast_wpseo_focuskw',
    ];

    foreach ($post_types as $type) {
        foreach ($meta_keys as $key) {
            register_post_meta($type, $key, [
                'show_in_rest'  => true,
                'single'        => true,
                'type'          => 'string',
                'auth_callback' => function() { return current_user_can('edit_posts'); },
            ]);
        }
    }
});

// Expose yoast_head_json in REST API responses (already done by Yoast, but ensure it)
add_filter('rest_prepare_page', 'seoroom_add_yoast_to_rest', 10, 3);
add_filter('rest_prepare_post', 'seoroom_add_yoast_to_rest', 10, 3);

function seoroom_add_yoast_to_rest($response, $post, $request) {
    // Add raw Yoast meta for easy access
    $response->data['seoroom_yoast'] = [
        'title'         => get_post_meta($post->ID, '_yoast_wpseo_title', true),
        'description'   => get_post_meta($post->ID, '_yoast_wpseo_metadesc', true),
        'focus_keyword' => get_post_meta($post->ID, '_yoast_wpseo_focuskw', true),
        'seo_score'     => get_post_meta($post->ID, '_yoast_wpseo_linkdex', true),
        'content_score' => get_post_meta($post->ID, '_yoast_wpseo_content_score', true),
    ];
    return $response;
}

// REST endpoint: /wp-json/seoroom/v1/yoast-scores
add_action('rest_api_init', function() {
    register_rest_route('seoroom/v1', '/yoast-scores', [
        'methods'  => 'GET',
        'callback' => 'seoroom_yoast_scores',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});

function seoroom_yoast_scores() {
    $results = [];
    $post_types = ['page', 'post'];
    foreach ($post_types as $type) {
        $posts = get_posts([
            'post_type'      => $type,
            'post_status'    => 'publish',
            'posts_per_page' => -1,
        ]);
        foreach ($posts as $p) {
            $results[] = [
                'id'            => $p->ID,
                'title'         => $p->post_title,
                'type'          => $type,
                'focus_keyword' => get_post_meta($p->ID, '_yoast_wpseo_focuskw', true),
                'seo_score'     => get_post_meta($p->ID, '_yoast_wpseo_linkdex', true),
                'content_score' => get_post_meta($p->ID, '_yoast_wpseo_content_score', true),
                'meta_title'    => get_post_meta($p->ID, '_yoast_wpseo_title', true),
                'meta_desc'     => get_post_meta($p->ID, '_yoast_wpseo_metadesc', true),
            ];
        }
    }
    return rest_ensure_response($results);
}

// ============================================================
// CWV AUTO-FIX SYSTEM (v2.0)
// Applies performance fixes via WordPress hooks — no theme changes.
// All fixes are stored in wp_options and can be rolled back instantly.
// ============================================================

define('SEOROOM_CWV_OPTION', 'seoroom_cwv_fixes');
define('SEOROOM_CWV_HISTORY', 'seoroom_cwv_history');

// Get active fixes
function seoroom_get_fixes() {
    return get_option(SEOROOM_CWV_OPTION, []);
}

// Save fixes
function seoroom_save_fixes($fixes) {
    update_option(SEOROOM_CWV_OPTION, $fixes);
}

// Add to history for rollback
function seoroom_log_history($action, $fix_data) {
    $history = get_option(SEOROOM_CWV_HISTORY, []);
    $history[] = [
        'action'    => $action,
        'fix'       => $fix_data,
        'timestamp' => current_time('mysql'),
    ];
    // Keep last 200 entries
    if (count($history) > 200) $history = array_slice($history, -200);
    update_option(SEOROOM_CWV_HISTORY, $history);
}

// ---- REST API ENDPOINTS ----

add_action('rest_api_init', function() {
    // Apply a CWV fix
    register_rest_route('seoroom/v1', '/cwv-fix', [
        'methods'  => 'POST',
        'callback' => 'seoroom_apply_cwv_fix',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);

    // List active fixes
    register_rest_route('seoroom/v1', '/cwv-fixes', [
        'methods'  => 'GET',
        'callback' => 'seoroom_list_cwv_fixes',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);

    // Rollback a fix
    register_rest_route('seoroom/v1', '/cwv-fix/rollback', [
        'methods'  => 'POST',
        'callback' => 'seoroom_rollback_cwv_fix',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);

    // Rollback ALL fixes
    register_rest_route('seoroom/v1', '/cwv-fix/rollback-all', [
        'methods'  => 'POST',
        'callback' => 'seoroom_rollback_all_cwv_fixes',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);

    // Get fix history
    register_rest_route('seoroom/v1', '/cwv-history', [
        'methods'  => 'GET',
        'callback' => function() { return rest_ensure_response(get_option(SEOROOM_CWV_HISTORY, [])); },
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});

function seoroom_apply_cwv_fix($request) {
    $fix_type = sanitize_text_field($request->get_param('fix_type'));
    $params   = $request->get_param('params') ?: [];
    $page_url = sanitize_text_field($request->get_param('page_url') ?: '');

    $valid_types = [
        'preconnect',        // Add preconnect hint for a domain
        'preload_resource',  // Preload a critical resource (font, image, CSS)
        'fetchpriority',     // Add fetchpriority="high" to LCP image
        'font_display_swap', // Add font-display:swap to Google Fonts
        'defer_script',      // Defer a specific script
        'delay_script',      // Delay a third-party script until interaction
        'image_dimensions',  // Add width/height to images missing dimensions
        'lazy_load',         // Add loading="lazy" to offscreen images
        'critical_css',      // Inline critical CSS
        'remove_unused_css', // Remove a specific CSS file on specific pages
        'dns_prefetch',      // DNS prefetch for third-party domains
        'custom_snippet',    // Custom PHP/HTML snippet (for edge cases)
    ];

    if (!in_array($fix_type, $valid_types)) {
        return new WP_Error('invalid_type', 'Invalid fix type: ' . $fix_type, ['status' => 400]);
    }

    // Sanitize params
    $clean_params = [];
    foreach ($params as $k => $v) {
        $clean_params[sanitize_text_field($k)] = is_array($v) ? array_map('sanitize_text_field', $v) : sanitize_text_field($v);
    }

    $fix = [
        'id'         => 'cwv_' . wp_generate_uuid4(),
        'fix_type'   => $fix_type,
        'params'     => $clean_params,
        'page_url'   => $page_url,
        'applied_at' => current_time('mysql'),
        'active'     => true,
    ];

    $fixes = seoroom_get_fixes();
    $fixes[] = $fix;
    seoroom_save_fixes($fixes);
    seoroom_log_history('applied', $fix);

    return rest_ensure_response([
        'success' => true,
        'fix_id'  => $fix['id'],
        'message' => "Applied {$fix_type} fix",
    ]);
}

function seoroom_list_cwv_fixes() {
    return rest_ensure_response(seoroom_get_fixes());
}

function seoroom_rollback_cwv_fix($request) {
    $fix_id = sanitize_text_field($request->get_param('fix_id'));
    $fixes = seoroom_get_fixes();
    $removed = null;

    $fixes = array_values(array_filter($fixes, function($f) use ($fix_id, &$removed) {
        if ($f['id'] === $fix_id) { $removed = $f; return false; }
        return true;
    }));

    if (!$removed) {
        return new WP_Error('not_found', 'Fix not found', ['status' => 404]);
    }

    seoroom_save_fixes($fixes);
    seoroom_log_history('rolled_back', $removed);

    return rest_ensure_response(['success' => true, 'message' => "Rolled back fix {$fix_id}"]);
}

function seoroom_rollback_all_cwv_fixes() {
    $fixes = seoroom_get_fixes();
    seoroom_save_fixes([]);
    seoroom_log_history('rolled_back_all', ['count' => count($fixes)]);
    return rest_ensure_response(['success' => true, 'message' => 'All CWV fixes rolled back', 'count' => count($fixes)]);
}

// ---- APPLY FIXES VIA WORDPRESS HOOKS ----

// Preconnect, DNS prefetch, preload, font-display, fetchpriority, critical CSS
add_action('wp_head', function() {
    $fixes = seoroom_get_fixes();
    if (empty($fixes)) return;

    $current_url = home_url($_SERVER['REQUEST_URI']);

    foreach ($fixes as $fix) {
        if (!$fix['active']) continue;
        // Page-specific fixes: only apply on matching page
        if (!empty($fix['page_url']) && strpos($current_url, rtrim($fix['page_url'], '/')) === false) continue;

        $p = $fix['params'];

        switch ($fix['fix_type']) {
            case 'preconnect':
                if (!empty($p['domain'])) {
                    $domain = esc_url($p['domain']);
                    $crossorigin = !empty($p['crossorigin']) ? ' crossorigin' : '';
                    echo "<link rel=\"preconnect\" href=\"{$domain}\"{$crossorigin}>\n";
                }
                break;

            case 'dns_prefetch':
                if (!empty($p['domain'])) {
                    echo '<link rel="dns-prefetch" href="' . esc_url($p['domain']) . "\">\n";
                }
                break;

            case 'preload_resource':
                if (!empty($p['url']) && !empty($p['as'])) {
                    $url = esc_url($p['url']);
                    $as = esc_attr($p['as']);
                    $type = !empty($p['type']) ? ' type="' . esc_attr($p['type']) . '"' : '';
                    $crossorigin = !empty($p['crossorigin']) ? ' crossorigin' : '';
                    echo "<link rel=\"preload\" href=\"{$url}\" as=\"{$as}\"{$type}{$crossorigin}>\n";
                }
                break;

            case 'font_display_swap':
                // Intercept Google Fonts and add &display=swap
                echo "<style>/* seoroom: font-display fix */\n";
                echo "@font-face { font-display: swap !important; }\n";
                echo "</style>\n";
                break;

            case 'critical_css':
                if (!empty($p['css'])) {
                    echo '<style id="seoroom-critical-css">' . wp_strip_all_tags($p['css']) . "</style>\n";
                }
                break;
        }
    }
}, 1); // Priority 1 = very early in <head>

// Fetchpriority + image dimensions via content filter
add_filter('the_content', function($content) {
    $fixes = seoroom_get_fixes();
    if (empty($fixes)) return $content;

    $current_url = home_url($_SERVER['REQUEST_URI']);

    foreach ($fixes as $fix) {
        if (!$fix['active']) continue;
        if (!empty($fix['page_url']) && strpos($current_url, rtrim($fix['page_url'], '/')) === false) continue;

        $p = $fix['params'];

        switch ($fix['fix_type']) {
            case 'fetchpriority':
                // Add fetchpriority="high" to the first image or a specific image
                if (!empty($p['image_src'])) {
                    $src = preg_quote($p['image_src'], '/');
                    $content = preg_replace(
                        '/(<img[^>]*src=["\'][^"\']*' . $src . '[^"\']*["\'][^>]*)>/i',
                        '$1 fetchpriority="high">',
                        $content, 1
                    );
                } else {
                    // Add to first image
                    $content = preg_replace(
                        '/(<img\b)(?![^>]*fetchpriority)/i',
                        '$1 fetchpriority="high"',
                        $content, 1
                    );
                }
                break;

            case 'image_dimensions':
                // Add width/height to images that are missing them
                if (!empty($p['image_src']) && !empty($p['width']) && !empty($p['height'])) {
                    $src = preg_quote($p['image_src'], '/');
                    $w = intval($p['width']);
                    $h = intval($p['height']);
                    // Only add if not already present
                    $content = preg_replace(
                        '/(<img[^>]*src=["\'][^"\']*' . $src . '[^"\']*["\'])(?![^>]*\bwidth=)([^>]*>)/i',
                        '$1 width="' . $w . '" height="' . $h . '"$2',
                        $content
                    );
                }
                break;

            case 'lazy_load':
                // Add loading="lazy" to offscreen images (skip first 2 images)
                $img_count = 0;
                $content = preg_replace_callback('/<img\b([^>]*)>/i', function($match) use (&$img_count) {
                    $img_count++;
                    if ($img_count <= 2) return $match[0]; // Don't lazy-load above-fold images
                    if (stripos($match[1], 'loading=') !== false) return $match[0]; // Already has loading attr
                    return '<img' . $match[1] . ' loading="lazy">';
                }, $content);
                break;
        }
    }

    return $content;
}, 20);

// Defer/delay scripts
add_filter('script_loader_tag', function($tag, $handle, $src) {
    $fixes = seoroom_get_fixes();
    if (empty($fixes)) return $tag;

    foreach ($fixes as $fix) {
        if (!$fix['active']) continue;
        $p = $fix['params'];

        if ($fix['fix_type'] === 'defer_script') {
            // Match by handle name or URL pattern
            $match = (!empty($p['handle']) && $handle === $p['handle'])
                  || (!empty($p['url_pattern']) && strpos($src, $p['url_pattern']) !== false);
            if ($match && strpos($tag, 'defer') === false) {
                $tag = str_replace(' src=', ' defer src=', $tag);
            }
        }

        if ($fix['fix_type'] === 'delay_script') {
            // Delay until user interaction (click/scroll/keydown)
            $match = (!empty($p['handle']) && $handle === $p['handle'])
                  || (!empty($p['url_pattern']) && strpos($src, $p['url_pattern']) !== false);
            if ($match) {
                $tag = str_replace(' src=', ' data-seoroom-delay="true" data-src=', $tag);
                $tag = str_replace("type='text/javascript'", "type='text/plain'", $tag);
                $tag = str_replace('type="text/javascript"', 'type="text/plain"', $tag);
            }
        }
    }

    return $tag;
}, 10, 3);

// Remove unused CSS on specific pages
add_action('wp_enqueue_scripts', function() {
    $fixes = seoroom_get_fixes();
    if (empty($fixes)) return;

    $current_url = home_url($_SERVER['REQUEST_URI']);

    foreach ($fixes as $fix) {
        if (!$fix['active'] || $fix['fix_type'] !== 'remove_unused_css') continue;
        if (!empty($fix['page_url']) && strpos($current_url, rtrim($fix['page_url'], '/')) === false) continue;

        $p = $fix['params'];
        if (!empty($p['handle'])) {
            wp_dequeue_style($p['handle']);
            wp_deregister_style($p['handle']);
        }
    }
}, 100);

// Delayed script loader (inject once if any delay_script fixes exist)
add_action('wp_footer', function() {
    $fixes = seoroom_get_fixes();
    $has_delayed = false;
    foreach ($fixes as $fix) {
        if ($fix['active'] && $fix['fix_type'] === 'delay_script') { $has_delayed = true; break; }
    }
    if (!$has_delayed) return;

    echo '<script>
    (function(){
        var loaded = false;
        function loadDelayed() {
            if (loaded) return;
            loaded = true;
            document.querySelectorAll("[data-seoroom-delay]").forEach(function(el) {
                var src = el.getAttribute("data-src");
                if (src) {
                    var s = document.createElement("script");
                    s.src = src;
                    s.defer = true;
                    document.body.appendChild(s);
                }
            });
        }
        ["click","scroll","keydown","mousemove","touchstart"].forEach(function(e) {
            document.addEventListener(e, loadDelayed, {once:true,passive:true});
        });
        setTimeout(loadDelayed, 5000);
    })();
    </script>';
}, 99);
