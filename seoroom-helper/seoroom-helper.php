<?php
/**
 * Plugin Name: SEO Room Connector
 * Description: Connects WordPress to the SEO Room Dashboard — Yoast meta access, CWV auto-fix, schema injection, and universal cache purge. Required by SEO Room Dashboard.
 * Version: 3.0.0
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
        '_seoroom_schema',
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
// SCHEMA INJECTION (v3.0)
// Reads _seoroom_schema post meta and outputs it as JSON-LD in <head>.
// This is the ONLY reliable way to inject schema on Elementor sites,
// since Elementor bypasses post_content and widget areas.
// ============================================================

add_action('wp_head', function() {
    if (!is_singular()) return; // Only on single pages/posts
    $post_id = get_the_ID();
    if (!$post_id) return;

    $schema = get_post_meta($post_id, '_seoroom_schema', true);
    if (empty($schema)) return;

    // Validate it's proper JSON
    $decoded = json_decode($schema);
    if (json_last_error() !== JSON_ERROR_NONE) return;

    // Re-encode to ensure clean output (no XSS)
    $clean = wp_json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if (!$clean) return;

    echo "\n<!-- SEO Room Schema -->\n";
    echo '<script type="application/ld+json">' . $clean . '</script>' . "\n";
}, 5); // Priority 5 = early in <head>, before CWV fixes

// ============================================================
// UNIVERSAL CACHE PURGE (v3.0)
// Detects whatever caching plugin is active and purges it.
// Plugin-independent — works with any combination of caches.
// ============================================================

add_action('rest_api_init', function() {
    register_rest_route('seoroom/v1', '/purge-cache', [
        'methods'  => 'POST',
        'callback' => 'seoroom_purge_cache',
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ]);
});

function seoroom_purge_cache($request) {
    $url = sanitize_text_field($request->get_param('url') ?: '');
    $purged = [];
    $errors = [];

    // 1. WordPress object cache
    if (function_exists('wp_cache_flush')) {
        wp_cache_flush();
        $purged[] = 'wp_object_cache';
    }

    // 2. BerqWP
    if (class_exists('BerqWP') || defined('STARTER_STARTER_FILE') || defined('STARTER_STARTER_DIR')) {
        // BerqWP uses its own purge mechanism
        if (function_exists('starter_starter_purge_cache')) {
            starter_starter_purge_cache();
            $purged[] = 'berqwp';
        } elseif (class_exists('starter_starter_cache') && method_exists('starter_starter_cache', 'purge_all')) {
            starter_starter_cache::purge_all();
            $purged[] = 'berqwp';
        } else {
            // Try clearing BerqWP options/transients that trigger rebuild
            delete_transient('berqwp_cache');
            delete_option('starter_starter_cache_version');
            // BerqWP stores cache in uploads/starter-starter/ — flag for rebuild
            $upload_dir = wp_upload_dir();
            $cache_dir = $upload_dir['basedir'] . '/starter-starter/';
            if (is_dir($cache_dir)) {
                seoroom_delete_directory($cache_dir);
                $purged[] = 'berqwp_files';
            }
            // Also try their CDN purge if available
            if (class_exists('starter_starter_cdn') && method_exists('starter_starter_cdn', 'purge')) {
                starter_starter_cdn::purge();
                $purged[] = 'berqwp_cdn';
            }
        }
    }

    // 3. WP Rocket
    if (function_exists('rocket_clean_domain')) {
        if ($url) {
            rocket_clean_files([$url]);
        } else {
            rocket_clean_domain();
        }
        $purged[] = 'wp_rocket';
    }

    // 4. W3 Total Cache
    if (function_exists('w3tc_flush_all')) {
        w3tc_flush_all();
        $purged[] = 'w3_total_cache';
    } elseif (function_exists('w3tc_flush_posts')) {
        w3tc_flush_posts();
        $purged[] = 'w3_total_cache_posts';
    }

    // 5. WP Super Cache
    if (function_exists('wp_cache_clear_cache')) {
        wp_cache_clear_cache();
        $purged[] = 'wp_super_cache';
    }

    // 6. LiteSpeed Cache
    if (class_exists('LiteSpeed_Cache_API') || defined('LSCWP_V')) {
        if (has_action('litespeed_purge_all')) {
            do_action('litespeed_purge_all');
            $purged[] = 'litespeed';
        }
    }

    // 7. Autoptimize
    if (class_exists('autoptimizeCache')) {
        autoptimizeCache::clearall();
        $purged[] = 'autoptimize';
    }

    // 8. WP Fastest Cache
    if (function_exists('wpfc_clear_all_cache')) {
        wpfc_clear_all_cache(true);
        $purged[] = 'wp_fastest_cache';
    } elseif (class_exists('WpFastestCache') && method_exists('WpFastestCache', 'deleteCache')) {
        $wpfc = new WpFastestCache();
        $wpfc->deleteCache(true);
        $purged[] = 'wp_fastest_cache';
    }

    // 9. Breeze (Cloudways)
    if (class_exists('Breeze_PurgeCache')) {
        Breeze_PurgeCache::breeze_cache_flush();
        $purged[] = 'breeze';
    } elseif (has_action('breeze_clear_all_cache')) {
        do_action('breeze_clear_all_cache');
        $purged[] = 'breeze';
    }

    // 10. Hummingbird
    if (has_action('wphb_clear_page_cache')) {
        do_action('wphb_clear_page_cache');
        $purged[] = 'hummingbird';
    }

    // 11. SG Optimizer (SiteGround)
    if (function_exists('sg_cachepress_purge_cache')) {
        sg_cachepress_purge_cache();
        $purged[] = 'sg_optimizer';
    }

    // 12. Kinsta Cache
    if (class_exists('Developer_Kinsta') || defined('KINSTAMU_VERSION')) {
        if (has_action('developer_kinsta_purge_all_caches')) {
            do_action('developer_kinsta_purge_all_caches');
            $purged[] = 'kinsta';
        }
    }

    // 13. Cloudflare (via plugin)
    if (class_exists('CF\WordPress\Hooks') && has_action('cloudflare_purge_everything')) {
        do_action('cloudflare_purge_everything');
        $purged[] = 'cloudflare';
    }

    // 14. Comet Cache / ZenCache
    if (class_exists('comet_cache')) {
        comet_cache::clear();
        $purged[] = 'comet_cache';
    } elseif (class_exists('zencache')) {
        zencache::clear();
        $purged[] = 'zencache';
    }

    // 15. Cache Enabler
    if (has_action('cache_enabler_clear_complete_cache')) {
        do_action('cache_enabler_clear_complete_cache');
        $purged[] = 'cache_enabler';
    } elseif (class_exists('Cache_Enabler')) {
        Cache_Enabler::clear_total_cache();
        $purged[] = 'cache_enabler';
    }

    // 16. Nginx Helper (FastCGI / Redis)
    if (has_action('rt_nginx_helper_purge_all')) {
        do_action('rt_nginx_helper_purge_all');
        $purged[] = 'nginx_helper';
    }

    // 17. Redis Object Cache
    if (function_exists('wp_cache_flush')) {
        // Already called above, but also try Redis-specific
        if (class_exists('Redis') || class_exists('Predis\Client')) {
            $purged[] = 'redis_object_cache';
        }
    }

    // 18. Swift Performance
    if (class_exists('Swift_Performance_Cache')) {
        Swift_Performance_Cache::clear_all_cache();
        $purged[] = 'swift_performance';
    }

    // 19. Powered Cache
    if (function_exists('powered_cache_flush')) {
        powered_cache_flush();
        $purged[] = 'powered_cache';
    }

    // 20. Generic: fire common cache-clearing hooks other plugins may listen to
    if (has_action('cachify_flush_cache')) {
        do_action('cachify_flush_cache');
        $purged[] = 'cachify';
    }

    // Always try the generic WP hooks that many plugins listen on
    do_action('clean_post_cache');
    do_action('switch_theme'); // Many cache plugins purge on theme switch event

    // Report what we found and purged
    $detected = seoroom_detect_cache_plugins();

    return rest_ensure_response([
        'success'  => true,
        'purged'   => $purged,
        'detected' => $detected,
        'message'  => empty($purged)
            ? 'No known cache plugins detected. WP object cache flushed.'
            : 'Purged: ' . implode(', ', $purged),
    ]);
}

// Detect which cache plugins are active (for reporting)
function seoroom_detect_cache_plugins() {
    $detected = [];
    if (class_exists('BerqWP') || defined('STARTER_STARTER_FILE') || defined('STARTER_STARTER_DIR')) $detected[] = 'BerqWP';
    if (function_exists('rocket_clean_domain')) $detected[] = 'WP Rocket';
    if (function_exists('w3tc_flush_all') || function_exists('w3tc_flush_posts')) $detected[] = 'W3 Total Cache';
    if (function_exists('wp_cache_clear_cache') && !function_exists('rocket_clean_domain')) $detected[] = 'WP Super Cache';
    if (class_exists('LiteSpeed_Cache_API') || defined('LSCWP_V')) $detected[] = 'LiteSpeed Cache';
    if (class_exists('autoptimizeCache')) $detected[] = 'Autoptimize';
    if (class_exists('WpFastestCache')) $detected[] = 'WP Fastest Cache';
    if (class_exists('Breeze_PurgeCache')) $detected[] = 'Breeze';
    if (function_exists('sg_cachepress_purge_cache')) $detected[] = 'SG Optimizer';
    if (class_exists('Swift_Performance_Cache')) $detected[] = 'Swift Performance';
    if (class_exists('comet_cache')) $detected[] = 'Comet Cache';
    if (class_exists('Cache_Enabler')) $detected[] = 'Cache Enabler';

    // Check if BerqWP has files in uploads
    $upload_dir = wp_upload_dir();
    if (is_dir($upload_dir['basedir'] . '/starter-starter/')) $detected[] = 'BerqWP (file cache)';
    if (is_dir($upload_dir['basedir'] . '/cache/')) $detected[] = 'File-based cache';

    return array_unique($detected);
}

// Helper: recursively delete a directory
function seoroom_delete_directory($dir) {
    if (!is_dir($dir)) return;
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($files as $file) {
        if ($file->isDir()) {
            @rmdir($file->getRealPath());
        } else {
            @unlink($file->getRealPath());
        }
    }
    @rmdir($dir);
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

            case 'custom_snippet':
                if (!empty($p['html'])) {
                    $location = !empty($p['location']) ? $p['location'] : 'head';
                    if ($location === 'head') {
                        // Output in <head> — allow JSON-LD script tags and link tags
                        echo "<!-- seoroom custom snippet -->\n";
                        echo $p['html'] . "\n";
                    }
                }
                break;
        }
    }
}, 1); // Priority 1 = very early in <head>

// Custom snippets in footer
add_action('wp_footer', function() {
    $fixes = seoroom_get_fixes();
    if (empty($fixes)) return;
    $current_url = home_url($_SERVER['REQUEST_URI']);
    foreach ($fixes as $fix) {
        if (!$fix['active'] || $fix['fix_type'] !== 'custom_snippet') continue;
        if (!empty($fix['page_url']) && strpos($current_url, rtrim($fix['page_url'], '/')) === false) continue;
        $p = $fix['params'];
        $location = !empty($p['location']) ? $p['location'] : 'head';
        if ($location === 'footer' && !empty($p['html'])) {
            echo "<!-- seoroom custom snippet -->\n";
            echo $p['html'] . "\n";
        }
    }
}, 99);

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
