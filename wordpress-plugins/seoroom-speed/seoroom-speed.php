<?php
/**
 * Plugin Name: SEO Room Speed Optimizer
 * Plugin URI: https://theseoroom.com.au
 * Description: Automatic website speed optimization — lazy loading, CSS/JS minification, browser caching, GZIP compression, font optimization, and preconnect. Safe, non-destructive, instant revert on deactivation.
 * Version: 1.1.0
 * Author: The SEO Room
 * Author URI: https://theseoroom.com.au
 * License: GPL v2 or later
 * Text Domain: seoroom-speed
 */

if (!defined('ABSPATH')) exit;

define('SEOROOM_SPEED_VERSION', '1.1.0');
define('SEOROOM_SPEED_PATH', plugin_dir_path(__FILE__));
define('SEOROOM_SPEED_URL', plugin_dir_url(__FILE__));

// ============ DEFAULT OPTIONS ============
function seoroom_speed_defaults() {
    return array(
        'enable_lazy_load'     => true,
        'enable_image_dims'    => true,  // Add missing width/height
        'enable_css_minify'    => true,
        'enable_css_defer'     => false, // Off by default — can break layout
        'enable_js_defer'      => true,
        'enable_js_minify'     => true,
        'enable_gzip'          => true,
        'enable_cache_headers' => true,
        'enable_font_swap'     => true,
        'enable_preconnect'    => true,
        'enable_dns_prefetch'  => true,
        'safe_mode'            => false, // When on, only does safest optimizations
        'exclude_css'          => '',    // Comma-separated CSS handles to exclude
        'exclude_js'           => '',    // Comma-separated JS handles to exclude
        'cache_ttl'            => 604800, // 1 week in seconds
    );
}

function seoroom_speed_get_options() {
    $defaults = seoroom_speed_defaults();
    $options = get_option('seoroom_speed_options', array());
    return wp_parse_args($options, $defaults);
}

// ============ ACTIVATION / DEACTIVATION ============
register_activation_hook(__FILE__, 'seoroom_speed_activate');
function seoroom_speed_activate() {
    $options = seoroom_speed_get_options();
    update_option('seoroom_speed_options', $options);

    // API key for dashboard-driven fixes (scan / optimize-image / fix-hero)
    if (!get_option('seoroom_speed_key')) {
        update_option('seoroom_speed_key', 'srs_' . wp_generate_password(24, false));
    }

    // Create cache directory
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom-speed/';
    if (!file_exists($cache_dir)) {
        wp_mkdir_p($cache_dir);
    }

    // Flush rewrite rules to apply .htaccess changes
    flush_rewrite_rules();
}

register_deactivation_hook(__FILE__, 'seoroom_speed_deactivate');
function seoroom_speed_deactivate() {
    // Clean up cache
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom-speed/';
    if (file_exists($cache_dir)) {
        array_map('unlink', glob("$cache_dir*"));
        @rmdir($cache_dir);
    }
    // Remove .htaccess rules
    seoroom_speed_remove_htaccess_rules();
    flush_rewrite_rules();
}

// ============ ADMIN MENU & SETTINGS PAGE ============
add_action('admin_menu', 'seoroom_speed_admin_menu');
function seoroom_speed_admin_menu() {
    add_options_page(
        'SEO Room Speed',
        'SEO Room Speed',
        'manage_options',
        'seoroom-speed',
        'seoroom_speed_settings_page'
    );
}

add_action('admin_init', 'seoroom_speed_register_settings');
function seoroom_speed_register_settings() {
    register_setting('seoroom_speed_group', 'seoroom_speed_options', 'seoroom_speed_sanitize');
}

function seoroom_speed_sanitize($input) {
    $defaults = seoroom_speed_defaults();
    $sanitized = array();
    foreach ($defaults as $key => $default) {
        if (is_bool($default)) {
            $sanitized[$key] = !empty($input[$key]);
        } elseif (is_int($default)) {
            $sanitized[$key] = intval($input[$key] ?? $default);
        } else {
            $sanitized[$key] = sanitize_text_field($input[$key] ?? $default);
        }
    }

    // Update .htaccess when saving
    if ($sanitized['enable_gzip'] || $sanitized['enable_cache_headers']) {
        seoroom_speed_write_htaccess_rules($sanitized);
    } else {
        seoroom_speed_remove_htaccess_rules();
    }

    // Clear minified cache when settings change
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom-speed/';
    if (file_exists($cache_dir)) {
        array_map('unlink', glob("$cache_dir*.css"));
        array_map('unlink', glob("$cache_dir*.js"));
    }

    return $sanitized;
}

function seoroom_speed_settings_page() {
    $options = seoroom_speed_get_options();
    ?>
    <div class="wrap">
        <h1>SEO Room Speed Optimizer</h1>
        <p style="color:#666;">Automatic speed optimization. All changes are non-destructive — deactivate to instantly revert.</p>

        <form method="post" action="options.php">
            <?php settings_fields('seoroom_speed_group'); ?>

            <?php if ($options['safe_mode']): ?>
            <div style="background:#fff3cd;border:1px solid #ffc107;padding:12px 16px;border-radius:6px;margin-bottom:20px;">
                <strong>⚡ Safe Mode is ON</strong> — Only the safest optimizations are active (lazy load, font swap, preconnect, DNS prefetch).
            </div>
            <?php endif; ?>

            <table class="form-table">
                <tr>
                    <th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🛡️ Safety</h2></th>
                </tr>
                <tr>
                    <th>Safe Mode</th>
                    <td>
                        <label><input type="checkbox" name="seoroom_speed_options[safe_mode]" value="1" <?php checked($options['safe_mode']); ?> /> Enable safe mode (only non-breaking optimizations)</label>
                        <p class="description">When enabled, CSS/JS minification and deferral are disabled regardless of their individual settings.</p>
                    </td>
                </tr>

                <tr>
                    <th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🖼️ Images</h2></th>
                </tr>
                <tr>
                    <th>Lazy Loading</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_lazy_load]" value="1" <?php checked($options['enable_lazy_load']); ?> /> Add loading="lazy" to images and iframes below the fold</label></td>
                </tr>
                <tr>
                    <th>Image Dimensions</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_image_dims]" value="1" <?php checked($options['enable_image_dims']); ?> /> Add missing width/height attributes to prevent CLS</label></td>
                </tr>

                <tr>
                    <th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">📄 CSS</h2></th>
                </tr>
                <tr>
                    <th>Minify CSS</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_css_minify]" value="1" <?php checked($options['enable_css_minify']); ?> /> Minify CSS output (removes comments and whitespace)</label></td>
                </tr>
                <tr>
                    <th>Defer Non-Critical CSS</th>
                    <td>
                        <label><input type="checkbox" name="seoroom_speed_options[enable_css_defer]" value="1" <?php checked($options['enable_css_defer']); ?> /> Load non-critical CSS asynchronously</label>
                        <p class="description" style="color:#d63384;">⚠️ Can cause flash of unstyled content. Test carefully.</p>
                    </td>
                </tr>
                <tr>
                    <th>Exclude CSS</th>
                    <td>
                        <input type="text" name="seoroom_speed_options[exclude_css]" value="<?php echo esc_attr($options['exclude_css']); ?>" class="regular-text" />
                        <p class="description">Comma-separated CSS handles or filenames to exclude from optimization (e.g., <code>elementor-frontend,style</code>)</p>
                    </td>
                </tr>

                <tr>
                    <th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">⚡ JavaScript</h2></th>
                </tr>
                <tr>
                    <th>Defer JS</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_js_defer]" value="1" <?php checked($options['enable_js_defer']); ?> /> Add defer attribute to non-critical scripts</label></td>
                </tr>
                <tr>
                    <th>Minify JS</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_js_minify]" value="1" <?php checked($options['enable_js_minify']); ?> /> Minify inline JavaScript (removes comments and whitespace)</label></td>
                </tr>
                <tr>
                    <th>Exclude JS</th>
                    <td>
                        <input type="text" name="seoroom_speed_options[exclude_js]" value="<?php echo esc_attr($options['exclude_js']); ?>" class="regular-text" />
                        <p class="description">Comma-separated JS handles or filenames to exclude (e.g., <code>jquery-core,elementor-frontend</code>)</p>
                    </td>
                </tr>

                <tr>
                    <th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🌐 Server & Caching</h2></th>
                </tr>
                <tr>
                    <th>GZIP Compression</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_gzip]" value="1" <?php checked($options['enable_gzip']); ?> /> Enable GZIP compression via .htaccess</label></td>
                </tr>
                <tr>
                    <th>Browser Cache Headers</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_cache_headers]" value="1" <?php checked($options['enable_cache_headers']); ?> /> Set long-lived cache headers for static assets via .htaccess</label></td>
                </tr>

                <tr>
                    <th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🔤 Fonts & Preloading</h2></th>
                </tr>
                <tr>
                    <th>Font Display Swap</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_font_swap]" value="1" <?php checked($options['enable_font_swap']); ?> /> Add font-display:swap to prevent invisible text during font loading</label></td>
                </tr>
                <tr>
                    <th>Preconnect</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_preconnect]" value="1" <?php checked($options['enable_preconnect']); ?> /> Auto-detect and preconnect to external domains (Google Fonts, CDNs, analytics)</label></td>
                </tr>
                <tr>
                    <th>DNS Prefetch</th>
                    <td><label><input type="checkbox" name="seoroom_speed_options[enable_dns_prefetch]" value="1" <?php checked($options['enable_dns_prefetch']); ?> /> DNS prefetch for detected external domains</label></td>
                </tr>
            </table>

            <?php submit_button('Save & Apply'); ?>
        </form>

        <div style="margin-top:30px;padding:16px;background:#e7f1ff;border:1px solid #b6d4fe;border-radius:6px;">
            <h3 style="margin-top:0;">SEO Room Dashboard Connection</h3>
            <p>API key for dashboard-driven fixes (hero slideshow swap, image optimization):</p>
            <p><code style="font-size:14px;"><?php echo esc_html(get_option('seoroom_speed_key', '— activate the plugin to generate —')); ?></code></p>
            <p class="description">Paste this into Project Settings → Speed Plugin Key in the SEO Room dashboard.</p>
        </div>

        <div style="margin-top:30px;padding:16px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;">
            <h3 style="margin-top:0;">Quick Actions</h3>
            <p>
                <a href="<?php echo wp_nonce_url(admin_url('admin-post.php?action=seoroom_speed_clear_cache'), 'seoroom_speed_clear_cache'); ?>" class="button">Clear Optimization Cache</a>
                <a href="https://pagespeed.web.dev/analysis?url=<?php echo urlencode(home_url('/')); ?>" target="_blank" class="button">Test on PageSpeed Insights</a>
            </p>
        </div>
    </div>
    <?php
}

// Clear cache action
add_action('admin_post_seoroom_speed_clear_cache', function() {
    check_admin_referer('seoroom_speed_clear_cache');
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom-speed/';
    if (file_exists($cache_dir)) {
        array_map('unlink', glob("$cache_dir*"));
    }
    wp_redirect(admin_url('options-general.php?page=seoroom-speed&cleared=1'));
    exit;
});

// ============ 1. IMAGE OPTIMIZATION ============
// Lazy loading for images and iframes (skip first 2 images = above fold)
add_filter('the_content', 'seoroom_speed_lazy_load', 999);
add_filter('post_thumbnail_html', 'seoroom_speed_lazy_load', 999);
add_filter('widget_text', 'seoroom_speed_lazy_load', 999);

function seoroom_speed_lazy_load($content) {
    if (is_admin() || is_feed() || wp_doing_ajax()) return $content;
    $options = seoroom_speed_get_options();
    if (!$options['enable_lazy_load']) return $content;

    $count = 0;
    $skip_first = 2; // Don't lazy load first 2 images (likely above fold / LCP)

    // Images
    $content = preg_replace_callback('/<img\b([^>]*)>/i', function($matches) use (&$count, $skip_first) {
        $count++;
        $attrs = $matches[1];

        // Skip if already has loading attribute
        if (preg_match('/\bloading\s*=/i', $attrs)) return $matches[0];

        // Skip first N images (above the fold)
        if ($count <= $skip_first) {
            // Add fetchpriority="high" to first image (likely LCP)
            if ($count === 1 && !preg_match('/fetchpriority/i', $attrs)) {
                return '<img' . $attrs . ' fetchpriority="high">';
            }
            return $matches[0];
        }

        return '<img' . $attrs . ' loading="lazy">';
    }, $content);

    // Iframes (always lazy load)
    $content = preg_replace_callback('/<iframe\b([^>]*)>/i', function($matches) {
        $attrs = $matches[1];
        if (preg_match('/\bloading\s*=/i', $attrs)) return $matches[0];
        return '<iframe' . $attrs . ' loading="lazy">';
    }, $content);

    return $content;
}

// Add missing width/height to images to prevent CLS
add_filter('the_content', 'seoroom_speed_image_dimensions', 998);
function seoroom_speed_image_dimensions($content) {
    if (is_admin() || is_feed()) return $content;
    $options = seoroom_speed_get_options();
    if (!$options['enable_image_dims']) return $content;

    $content = preg_replace_callback('/<img\b([^>]*)>/i', function($matches) {
        $attrs = $matches[1];

        // Skip if already has both width and height
        if (preg_match('/\bwidth\s*=/i', $attrs) && preg_match('/\bheight\s*=/i', $attrs)) {
            return $matches[0];
        }

        // Try to get src
        if (!preg_match('/\bsrc\s*=\s*["\']([^"\']+)["\']/i', $attrs, $src_match)) {
            return $matches[0];
        }

        $src = $src_match[1];

        // Try to get dimensions from WordPress attachment
        $attachment_id = attachment_url_to_postid($src);
        if ($attachment_id) {
            $meta = wp_get_attachment_metadata($attachment_id);
            if ($meta && !empty($meta['width']) && !empty($meta['height'])) {
                $w = $meta['width'];
                $h = $meta['height'];

                // Check if a specific size is in the URL
                if (preg_match('/-(\d+)x(\d+)\.\w+$/', $src, $size_match)) {
                    $w = $size_match[1];
                    $h = $size_match[2];
                }

                if (!preg_match('/\bwidth\s*=/i', $attrs)) {
                    $attrs .= ' width="' . $w . '"';
                }
                if (!preg_match('/\bheight\s*=/i', $attrs)) {
                    $attrs .= ' height="' . $h . '"';
                }
                return '<img' . $attrs . '>';
            }
        }

        return $matches[0];
    }, $content);

    return $content;
}

// ============ 2. CSS OPTIMIZATION ============
// Minify CSS in <style> tags via output buffer
add_action('template_redirect', 'seoroom_speed_start_buffer', 1);
function seoroom_speed_start_buffer() {
    if (is_admin() || is_feed() || wp_doing_ajax()) return;
    if (defined('DOING_CRON') && DOING_CRON) return;

    $options = seoroom_speed_get_options();
    $needs_buffer = $options['enable_css_minify'] || $options['enable_js_minify'] || $options['enable_font_swap'] || $options['enable_preconnect'] || $options['enable_dns_prefetch'];

    if ($options['safe_mode']) {
        $needs_buffer = $options['enable_font_swap'] || $options['enable_preconnect'] || $options['enable_dns_prefetch'];
    }

    if ($needs_buffer) {
        ob_start('seoroom_speed_process_html');
    }
}

function seoroom_speed_process_html($html) {
    if (empty($html) || strlen($html) < 100) return $html;
    // Don't process non-HTML responses
    if (stripos($html, '<html') === false && stripos($html, '<!DOCTYPE') === false) return $html;

    $options = seoroom_speed_get_options();
    $is_safe = $options['safe_mode'];

    // CSS minification (inline <style> blocks)
    if ($options['enable_css_minify'] && !$is_safe) {
        $html = preg_replace_callback('/<style\b([^>]*)>(.*?)<\/style>/is', function($m) {
            $css = $m[2];
            // Simple safe minification — remove comments, extra whitespace
            $css = preg_replace('!/\*.*?\*/!s', '', $css); // Remove comments
            $css = preg_replace('/\s+/', ' ', $css); // Collapse whitespace
            $css = preg_replace('/\s*([{}:;,>~+])\s*/', '$1', $css); // Remove space around selectors
            $css = preg_replace('/;}/', '}', $css); // Remove trailing semicolons
            $css = trim($css);
            return '<style' . $m[1] . '>' . $css . '</style>';
        }, $html);
    }

    // JS minification (inline <script> blocks, NOT external)
    if ($options['enable_js_minify'] && !$is_safe) {
        $html = preg_replace_callback('/<script\b([^>]*)>(.*?)<\/script>/is', function($m) {
            $attrs = $m[1];
            $js = $m[2];
            // Skip external scripts, JSON-LD, templates
            if (preg_match('/\bsrc\s*=/i', $attrs)) return $m[0];
            if (preg_match('/type\s*=\s*["\'](?:application\/(?:ld\+json|json)|text\/(?:template|html))/i', $attrs)) return $m[0];
            if (empty(trim($js))) return $m[0];

            // Simple safe minification — only remove comments (NOT regex-safe for all cases, be conservative)
            $js = preg_replace('#^\s*//[^\n]*$#m', '', $js); // Remove single-line comments at start of line
            $js = preg_replace('/\s+/', ' ', $js); // Collapse whitespace
            $js = trim($js);
            return '<script' . $attrs . '>' . $js . '</script>';
        }, $html);
    }

    // Font-display: swap injection
    if ($options['enable_font_swap']) {
        // Add font-display:swap to @font-face blocks that don't have it
        $html = preg_replace_callback('/@font-face\s*\{([^}]+)\}/i', function($m) {
            if (stripos($m[1], 'font-display') !== false) return $m[0];
            $css = rtrim($m[1], '; ') . ';font-display:swap;';
            return '@font-face{' . $css . '}';
        }, $html);

        // Add &display=swap to Google Fonts URLs that don't have it
        $html = preg_replace_callback('/href\s*=\s*["\']([^"\']*fonts\.googleapis\.com[^"\']*)["\']/', function($m) {
            $url = $m[1];
            if (strpos($url, 'display=') !== false) return $m[0];
            $sep = strpos($url, '?') !== false ? '&' : '?';
            return str_replace($url, $url . $sep . 'display=swap', $m[0]);
        }, $html);
    }

    // Auto-detect external domains for preconnect and DNS prefetch
    if ($options['enable_preconnect'] || $options['enable_dns_prefetch']) {
        $external_domains = array();
        $site_host = parse_url(home_url(), PHP_URL_HOST);

        // Find all external URLs in the HTML
        preg_match_all('/(?:href|src)\s*=\s*["\']https?:\/\/([^"\'\/]+)/i', $html, $domain_matches);
        if (!empty($domain_matches[1])) {
            foreach ($domain_matches[1] as $domain) {
                $domain = strtolower($domain);
                if ($domain !== $site_host && !isset($external_domains[$domain])) {
                    $external_domains[$domain] = true;
                }
            }
        }

        // Known high-priority domains to preconnect
        $preconnect_priority = array(
            'fonts.googleapis.com', 'fonts.gstatic.com', 'www.googletagmanager.com',
            'www.google-analytics.com', 'cdnjs.cloudflare.com', 'ajax.googleapis.com',
            'maps.googleapis.com', 'www.google.com',
        );

        $preconnect_tags = '';
        $prefetch_tags = '';

        foreach ($external_domains as $domain => $v) {
            $url = 'https://' . $domain;
            // Check if already has preconnect/prefetch in HTML
            if (strpos($html, $domain) !== false && preg_match('/rel\s*=\s*["\'](?:preconnect|dns-prefetch)["\'][^>]*' . preg_quote($domain, '/') . '/', $html)) {
                continue;
            }
            if ($options['enable_preconnect'] && in_array($domain, $preconnect_priority)) {
                $crossorigin = (strpos($domain, 'gstatic.com') !== false) ? ' crossorigin' : '';
                $preconnect_tags .= '<link rel="preconnect" href="' . esc_url($url) . '"' . $crossorigin . '>' . "\n";
            }
            if ($options['enable_dns_prefetch']) {
                $prefetch_tags .= '<link rel="dns-prefetch" href="' . esc_url($url) . '">' . "\n";
            }
        }

        if ($preconnect_tags || $prefetch_tags) {
            $inject = $preconnect_tags . $prefetch_tags;
            // Inject after <head> or first <meta charset>
            if (preg_match('/<meta[^>]*charset[^>]*>/i', $html, $meta_match, PREG_OFFSET_CAPTURE)) {
                $pos = $meta_match[0][1] + strlen($meta_match[0][0]);
                $html = substr($html, 0, $pos) . "\n" . $inject . substr($html, $pos);
            } elseif (($head_pos = stripos($html, '<head>')) !== false) {
                $pos = $head_pos + 6;
                $html = substr($html, 0, $pos) . "\n" . $inject . substr($html, $pos);
            }
        }
    }

    return $html;
}

// ============ 3. JS OPTIMIZATION — DEFER/ASYNC ============
add_filter('script_loader_tag', 'seoroom_speed_defer_js', 10, 3);
function seoroom_speed_defer_js($tag, $handle, $src) {
    if (is_admin()) return $tag;
    $options = seoroom_speed_get_options();
    if (!$options['enable_js_defer'] || $options['safe_mode']) return $tag;

    // Never defer these critical scripts
    $never_defer = array(
        'jquery-core', 'jquery', 'jquery-migrate', 'wp-polyfill',
        'wp-hooks', 'wp-i18n', 'underscore', 'backbone',
    );
    if (in_array($handle, $never_defer)) return $tag;

    // Check user exclusions
    $excludes = array_filter(array_map('trim', explode(',', $options['exclude_js'])));
    foreach ($excludes as $exc) {
        if ($handle === $exc || strpos($src, $exc) !== false) return $tag;
    }

    // Skip if already has defer or async
    if (preg_match('/\b(defer|async)\b/i', $tag)) return $tag;

    // Add defer
    $tag = str_replace(' src=', ' defer src=', $tag);
    return $tag;
}

// ============ 4. CSS OPTIMIZATION — DEFER NON-CRITICAL ============
add_filter('style_loader_tag', 'seoroom_speed_optimize_css_tag', 10, 4);
function seoroom_speed_optimize_css_tag($tag, $handle, $href, $media) {
    if (is_admin()) return $tag;
    $options = seoroom_speed_get_options();

    if ($options['safe_mode']) return $tag;

    // Check user exclusions
    $excludes = array_filter(array_map('trim', explode(',', $options['exclude_css'])));
    foreach ($excludes as $exc) {
        if ($handle === $exc || strpos($href, $exc) !== false) return $tag;
    }

    // Defer non-critical CSS (if enabled)
    if ($options['enable_css_defer']) {
        // Never defer critical CSS
        $never_defer_css = array(
            'wp-block-library', 'global-styles', 'theme-style', 'style',
            'elementor-frontend', 'elementor-common', 'elementor-icons',
            'astra-theme-css', 'generatepress', 'flavflavor',
        );
        if (in_array($handle, $never_defer_css)) return $tag;

        // Convert to async loading: media="print" with onload switch
        $tag = str_replace(
            "media='all'",
            "media='print' onload=\"this.media='all'\"",
            $tag
        );
        $tag = str_replace(
            'media="all"',
            'media="print" onload="this.media=\'all\'"',
            $tag
        );
    }

    return $tag;
}

// ============ 5. HTACCESS — GZIP & CACHE HEADERS ============
function seoroom_speed_write_htaccess_rules($options = null) {
    if (!$options) $options = seoroom_speed_get_options();

    $htaccess_file = get_home_path() . '.htaccess';
    if (!file_exists($htaccess_file) || !is_writable($htaccess_file)) return false;

    $rules = "\n# BEGIN SEO Room Speed Optimizer\n";

    // GZIP compression
    if ($options['enable_gzip']) {
        $rules .= "<IfModule mod_deflate.c>\n";
        $rules .= "  AddOutputFilterByType DEFLATE text/html text/plain text/xml text/css text/javascript\n";
        $rules .= "  AddOutputFilterByType DEFLATE application/javascript application/x-javascript application/json\n";
        $rules .= "  AddOutputFilterByType DEFLATE application/xml application/xhtml+xml application/rss+xml\n";
        $rules .= "  AddOutputFilterByType DEFLATE image/svg+xml image/x-icon\n";
        $rules .= "  AddOutputFilterByType DEFLATE font/ttf font/otf font/woff font/woff2\n";
        $rules .= "</IfModule>\n\n";
    }

    // Browser cache headers
    if ($options['enable_cache_headers']) {
        $rules .= "<IfModule mod_expires.c>\n";
        $rules .= "  ExpiresActive On\n";
        $rules .= "  ExpiresByType text/css \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType application/javascript \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType application/x-javascript \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType image/jpeg \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType image/png \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType image/gif \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType image/webp \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType image/avif \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType image/svg+xml \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType image/x-icon \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType font/woff2 \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType font/woff \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType font/ttf \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType font/otf \"access plus 1 year\"\n";
        $rules .= "  ExpiresByType text/html \"access plus 1 hour\"\n";
        $rules .= "</IfModule>\n\n";

        $rules .= "<IfModule mod_headers.c>\n";
        $rules .= "  <FilesMatch \"\\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2|woff|ttf|otf)$\">\n";
        $rules .= "    Header set Cache-Control \"public, max-age=31536000, immutable\"\n";
        $rules .= "  </FilesMatch>\n";
        $rules .= "  <FilesMatch \"\\.(html|htm)$\">\n";
        $rules .= "    Header set Cache-Control \"public, max-age=3600, must-revalidate\"\n";
        $rules .= "  </FilesMatch>\n";
        $rules .= "</IfModule>\n";
    }

    $rules .= "# END SEO Room Speed Optimizer\n";

    // Read existing .htaccess
    $existing = file_get_contents($htaccess_file);

    // Remove old rules
    $existing = preg_replace('/\n?# BEGIN SEO Room Speed Optimizer.*?# END SEO Room Speed Optimizer\n?/s', '', $existing);

    // Prepend new rules (before WordPress rules)
    if (($wp_pos = strpos($existing, '# BEGIN WordPress')) !== false) {
        $existing = substr($existing, 0, $wp_pos) . $rules . "\n" . substr($existing, $wp_pos);
    } else {
        $existing = $rules . "\n" . $existing;
    }

    file_put_contents($htaccess_file, $existing);
    return true;
}

function seoroom_speed_remove_htaccess_rules() {
    $htaccess_file = get_home_path() . '.htaccess';
    if (!file_exists($htaccess_file) || !is_writable($htaccess_file)) return;

    $existing = file_get_contents($htaccess_file);
    $existing = preg_replace('/\n?# BEGIN SEO Room Speed Optimizer.*?# END SEO Room Speed Optimizer\n?/s', '', $existing);
    file_put_contents($htaccess_file, $existing);
}

// Write .htaccess rules on activation
add_action('init', function() {
    if (get_transient('seoroom_speed_htaccess_written')) return;
    $options = seoroom_speed_get_options();
    if ($options['enable_gzip'] || $options['enable_cache_headers']) {
        seoroom_speed_write_htaccess_rules($options);
        set_transient('seoroom_speed_htaccess_written', true, DAY_IN_SECONDS);
    }
});

// ============ 6. PRELOAD LCP IMAGE ============
add_action('wp_head', 'seoroom_speed_preload_hints', 1);
function seoroom_speed_preload_hints() {
    if (is_admin()) return;
    $options = seoroom_speed_get_options();

    // Preload featured image on singular pages (likely LCP element)
    if (is_singular() && has_post_thumbnail()) {
        $thumb_id = get_post_thumbnail_id();
        $thumb_url = wp_get_attachment_image_url($thumb_id, 'large');
        if ($thumb_url) {
            echo '<link rel="preload" as="image" href="' . esc_url($thumb_url) . '">' . "\n";
        }
    }
}

// ============ 7. REMOVE WORDPRESS BLOAT ============
add_action('init', 'seoroom_speed_remove_bloat');
function seoroom_speed_remove_bloat() {
    if (is_admin()) return;

    // Remove emoji scripts
    remove_action('wp_head', 'print_emoji_detection_script', 7);
    remove_action('wp_print_styles', 'print_emoji_styles');
    remove_action('admin_print_scripts', 'print_emoji_detection_script');
    remove_action('admin_print_styles', 'print_emoji_styles');

    // Remove wlwmanifest link
    remove_action('wp_head', 'wlwmanifest_link');

    // Remove RSD link
    remove_action('wp_head', 'rsd_link');

    // Remove WordPress version
    remove_action('wp_head', 'wp_generator');

    // Remove shortlink
    remove_action('wp_head', 'wp_shortlink_wp_head');

    // Disable self-pingbacks
    add_action('pre_ping', function(&$links) {
        $home = home_url();
        foreach ($links as $l => $link) {
            if (strpos($link, $home) === 0) unset($links[$l]);
        }
    });
}

// Disable emoji DNS prefetch
add_filter('emoji_svg_url', '__return_false');

// Remove jQuery Migrate if not needed (WP 5.6+)
add_action('wp_default_scripts', function($scripts) {
    if (is_admin()) return;
    if (isset($scripts->registered['jquery'])) {
        $script = $scripts->registered['jquery'];
        if ($script->deps) {
            $script->deps = array_diff($script->deps, array('jquery-migrate'));
        }
    }
});

// ============ 8. ADMIN BAR STATUS ============
add_action('admin_bar_menu', 'seoroom_speed_admin_bar', 999);
function seoroom_speed_admin_bar($wp_admin_bar) {
    if (!current_user_can('manage_options')) return;

    $options = seoroom_speed_get_options();
    $status = $options['safe_mode'] ? '⚡ Safe' : '⚡ Active';

    $wp_admin_bar->add_node(array(
        'id'    => 'seoroom-speed',
        'title' => $status,
        'href'  => admin_url('options-general.php?page=seoroom-speed'),
        'meta'  => array('title' => 'SEO Room Speed Optimizer'),
    ));
}

// ============ DASHBOARD-DRIVEN FIXES (key-authenticated) ============
// These target what generic optimizers and BerqWP CANNOT reach:
// Elementor background SLIDESHOWS (the classic 25s-LCP killer) and oversized CSS background images.

function seoroom_speed_auth_key(WP_REST_Request $req) {
    $key = $req->get_param('key');
    $stored = get_option('seoroom_speed_key', '');
    return is_string($key) && $stored && hash_equals($stored, $key);
}

function seoroom_speed_file_kb($url) {
    $up = wp_upload_dir();
    if (strpos($url, $up['baseurl']) !== 0) return null;
    $path = str_replace($up['baseurl'], $up['basedir'], $url);
    return file_exists($path) ? (int) round(filesize($path) / 1024) : null;
}

function seoroom_speed_walk(array &$nodes, callable $fn) {
    foreach ($nodes as &$node) {
        if (is_array($node)) {
            $fn($node);
            if (!empty($node['elements']) && is_array($node['elements'])) seoroom_speed_walk($node['elements'], $fn);
        }
    }
}

add_action('rest_api_init', function () {
    // SCAN: find slideshow heroes + oversized background images across the site
    register_rest_route('seoroom/v1', '/speed-scan', array(
        'methods' => 'GET', 'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $req) {
            if (!seoroom_speed_auth_key($req)) return new WP_Error('forbidden', 'Bad key', array('status' => 403));
            $findings = array();
            $q = new WP_Query(array('post_type' => array('page', 'post'), 'post_status' => 'publish', 'posts_per_page' => 300, 'fields' => 'ids'));
            foreach ($q->posts as $pid) {
                $el = get_post_meta($pid, '_elementor_data', true);
                if (!$el || !is_string($el)) continue;
                $item = array('page_id' => $pid, 'title' => get_the_title($pid), 'url' => get_permalink($pid), 'slideshows' => array(), 'big_backgrounds' => array());
                if (strpos($el, '"background_background":"slideshow"') !== false) {
                    $data = json_decode($el, true);
                    if (is_array($data)) {
                        seoroom_speed_walk($data, function (&$node) use (&$item) {
                            if (!empty($node['settings']['background_background']) && $node['settings']['background_background'] === 'slideshow') {
                                $slides = array();
                                $gallery = isset($node['settings']['background_slideshow_gallery']) ? $node['settings']['background_slideshow_gallery'] : array();
                                foreach ($gallery as $s) {
                                    if (!empty($s['url'])) $slides[] = array('url' => $s['url'], 'kb' => seoroom_speed_file_kb($s['url']));
                                }
                                $item['slideshows'][] = array('element_id' => isset($node['id']) ? $node['id'] : '', 'slides' => $slides);
                            }
                        });
                    }
                }
                if (preg_match_all('/"background_image":\{[^}]*"url":"([^"]+)"/', $el, $m)) {
                    foreach (array_unique($m[1]) as $u) {
                        $u = stripslashes($u);
                        $kb = seoroom_speed_file_kb($u);
                        if ($kb !== null && $kb > 400) $item['big_backgrounds'][] = array('url' => $u, 'kb' => $kb);
                    }
                }
                if ($item['slideshows'] || $item['big_backgrounds']) $findings[] = $item;
            }
            return array('ok' => true, 'findings' => $findings, 'scanned' => count($q->posts));
        },
    ));

    // OPTIMIZE IMAGE: resize + convert to WebP using WP's own image engine
    register_rest_route('seoroom/v1', '/speed-optimize-image', array(
        'methods' => 'POST', 'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $req) {
            if (!seoroom_speed_auth_key($req)) return new WP_Error('forbidden', 'Bad key', array('status' => 403));
            $url = $req->get_param('url');
            $max_w = (int) ($req->get_param('max_width') ?: 1920);
            $quality = (int) ($req->get_param('quality') ?: 72);
            $up = wp_upload_dir();
            if (!$url || strpos($url, $up['baseurl']) !== 0) return new WP_Error('bad_url', 'URL must be inside uploads', array('status' => 400));
            $path = str_replace($up['baseurl'], $up['basedir'], $url);
            if (!file_exists($path)) return new WP_Error('not_found', 'File not found', array('status' => 404));
            $editor = wp_get_image_editor($path);
            if (is_wp_error($editor)) return $editor;
            $size = $editor->get_size();
            if (!empty($size['width']) && $size['width'] > $max_w) $editor->resize($max_w, null, false);
            $editor->set_quality($quality);
            $dest = preg_replace('/\.(jpe?g|png)$/i', '', $path) . '-optimized.webp';
            $saved = $editor->save($dest, 'image/webp');
            if (is_wp_error($saved)) return $saved;
            $new_url = str_replace($up['basedir'], $up['baseurl'], $saved['path']);
            return array(
                'ok' => true,
                'original_url' => $url, 'original_kb' => (int) round(filesize($path) / 1024),
                'optimized_url' => $new_url, 'optimized_kb' => (int) round(filesize($saved['path']) / 1024),
            );
        },
    ));

    // FIX HERO: swap an Elementor background slideshow to a static (optimized) image
    register_rest_route('seoroom/v1', '/speed-fix-hero', array(
        'methods' => 'POST', 'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $req) {
            if (!seoroom_speed_auth_key($req)) return new WP_Error('forbidden', 'Bad key', array('status' => 403));
            $pid = (int) $req->get_param('page_id');
            $image_url = $req->get_param('image_url');
            $element_id = $req->get_param('element_id');
            if (!$pid) return new WP_Error('bad_request', 'page_id required', array('status' => 400));
            $el = get_post_meta($pid, '_elementor_data', true);
            if (!$el || !is_string($el)) return new WP_Error('no_elementor', 'No Elementor data on this page', array('status' => 400));
            $original = $el;
            $data = json_decode($el, true);
            if (!is_array($data)) return new WP_Error('bad_json', 'Could not parse Elementor data', array('status' => 500));
            $changed = false;
            $used_image = null;
            seoroom_speed_walk($data, function (&$node) use (&$changed, &$used_image, $image_url, $element_id) {
                if ($changed) return;
                if (empty($node['settings']['background_background']) || $node['settings']['background_background'] !== 'slideshow') return;
                if ($element_id && ((isset($node['id']) ? $node['id'] : '') !== $element_id)) return;
                $first = isset($node['settings']['background_slideshow_gallery'][0]['url']) ? $node['settings']['background_slideshow_gallery'][0]['url'] : null;
                $img = $image_url ?: $first;
                if (!$img) return;
                $node['settings']['background_background'] = 'classic';
                $node['settings']['background_image'] = array('url' => $img, 'id' => '', 'size' => '');
                $node['settings']['background_size'] = 'cover';
                $node['settings']['background_position'] = 'center center';
                $used_image = $img;
                $changed = true;
            });
            if (!$changed) return new WP_Error('not_found', 'No slideshow background found on this page', array('status' => 404));
            $new_json = wp_json_encode($data);
            $new_json = str_replace('"settings":[]', '"settings":{}', $new_json); // Elementor {} vs [] safety net
            update_post_meta($pid, '_elementor_data', wp_slash($new_json));
            delete_post_meta($pid, '_elementor_css');
            if (class_exists('\\Elementor\\Plugin')) {
                try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
            }
            return array('ok' => true, 'page_id' => $pid, 'image_used' => $used_image, 'original_elementor' => $original, 'new_elementor' => $new_json);
        },
    ));

    // RESTORE: rollback a hero fix using the original Elementor JSON (sent back by the dashboard)
    register_rest_route('seoroom/v1', '/speed-restore-elementor', array(
        'methods' => 'POST', 'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $req) {
            if (!seoroom_speed_auth_key($req)) return new WP_Error('forbidden', 'Bad key', array('status' => 403));
            $pid = (int) $req->get_param('page_id');
            $json = $req->get_param('elementor_json');
            if (!$pid || !$json) return new WP_Error('bad_request', 'page_id and elementor_json required', array('status' => 400));
            update_post_meta($pid, '_elementor_data', wp_slash($json));
            delete_post_meta($pid, '_elementor_css');
            if (class_exists('\\Elementor\\Plugin')) {
                try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
            }
            return array('ok' => true, 'page_id' => $pid, 'restored' => true);
        },
    ));
});

// ============ REST API STATUS ENDPOINT ============
add_action('rest_api_init', function() {
    register_rest_route('seoroom/v1', '/speed-status', array(
        'methods'  => 'GET',
        'callback' => function() {
            $options = seoroom_speed_get_options();
            return new WP_REST_Response(array(
                'active'    => true,
                'version'   => SEOROOM_SPEED_VERSION,
                'safe_mode' => $options['safe_mode'],
                'features'  => array(
                    'lazy_load'     => $options['enable_lazy_load'],
                    'image_dims'    => $options['enable_image_dims'],
                    'css_minify'    => $options['enable_css_minify'] && !$options['safe_mode'],
                    'css_defer'     => $options['enable_css_defer'] && !$options['safe_mode'],
                    'js_defer'      => $options['enable_js_defer'] && !$options['safe_mode'],
                    'js_minify'     => $options['enable_js_minify'] && !$options['safe_mode'],
                    'gzip'          => $options['enable_gzip'],
                    'cache_headers' => $options['enable_cache_headers'],
                    'font_swap'     => $options['enable_font_swap'],
                    'preconnect'    => $options['enable_preconnect'],
                    'dns_prefetch'  => $options['enable_dns_prefetch'],
                ),
            ), 200);
        },
        'permission_callback' => '__return_true',
    ));
});
