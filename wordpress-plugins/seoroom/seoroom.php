<?php
/**
 * Plugin Name: SEO Room
 * Plugin URI: https://theseoroom.com.au
 * Description: All-in-one SEO optimization — automatic speed optimization (lazy loading, CSS/JS minification, browser caching, GZIP, font optimization, preconnect) + JSON-LD schema injection. Safe, non-destructive, instant revert on deactivation.
 * Version: 4.1.0
 * Author: The SEO Room
 * Author URI: https://theseoroom.com.au
 * License: GPL v2 or later
 * Text Domain: seoroom
 */

if (!defined('ABSPATH')) exit;

define('SEOROOM_VERSION', '4.1.0');
define('SEOROOM_PATH', plugin_dir_path(__FILE__));
define('SEOROOM_URL', plugin_dir_url(__FILE__));

// ============ DEFAULT OPTIONS ============
function sropt_defaults() {
    return array(
        // Speed
        'enable_lazy_load'     => true,
        'enable_image_dims'    => true,
        'enable_css_minify'    => true,
        'enable_css_defer'     => false, // Off by default — can break layout
        'enable_js_defer'      => true,
        'enable_js_minify'     => true,
        'enable_gzip'          => true,
        'enable_cache_headers' => true,
        'enable_font_swap'     => true,
        'enable_preconnect'    => true,
        'enable_dns_prefetch'  => true,
        'safe_mode'            => false,
        'exclude_css'          => '',
        'exclude_js'           => '',
        'cache_ttl'            => 604800,
        // Page Cache
        'enable_page_cache'    => true,
        'page_cache_ttl'       => 86400, // 24 hours
        'cache_exclude_urls'   => '',
        // WebP
        'enable_webp'          => true,
        'webp_quality'         => 80,
        // Schema
        'enable_schema'        => true,
    );
}

function sropt_get_options() {
    $defaults = sropt_defaults();
    $options = get_option('sropt_options', array());
    return wp_parse_args($options, $defaults);
}

// ============ ACTIVATION / DEACTIVATION ============
register_activation_hook(__FILE__, 'sropt_activate');
function sropt_activate() {
    $options = sropt_get_options();
    update_option('sropt_options', $options);

    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom/';
    if (!file_exists($cache_dir)) wp_mkdir_p($cache_dir);

    $page_cache_dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (!file_exists($page_cache_dir)) wp_mkdir_p($page_cache_dir);

    $webp_dir = WP_CONTENT_DIR . '/cache/seoroom/webp/';
    if (!file_exists($webp_dir)) wp_mkdir_p($webp_dir);

    flush_rewrite_rules();
}

register_deactivation_hook(__FILE__, 'sropt_deactivate');
function sropt_deactivate() {
    // Clean up all cache directories
    $dirs = array(
        WP_CONTENT_DIR . '/cache/seoroom/pages/',
        WP_CONTENT_DIR . '/cache/seoroom/webp/',
        WP_CONTENT_DIR . '/cache/seoroom/',
    );
    foreach ($dirs as $dir) {
        if (file_exists($dir)) {
            $files = glob($dir . '*');
            if ($files) array_map(function($f) { if (is_file($f)) @unlink($f); }, $files);
            @rmdir($dir);
        }
    }
    sropt_remove_htaccess_rules();
    flush_rewrite_rules();
}

// ============ ADMIN MENU & SETTINGS PAGE ============
add_action('admin_menu', 'sropt_admin_menu');
function sropt_admin_menu() {
    add_options_page('SEO Room', 'SEO Room', 'manage_options', 'seoroom', 'sropt_settings_page');
}

add_action('admin_init', 'sropt_register_settings');
function sropt_register_settings() {
    register_setting('sropt_group', 'sropt_options', 'sropt_sanitize');
}

function sropt_sanitize($input) {
    $defaults = sropt_defaults();
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

    if ($sanitized['enable_gzip'] || $sanitized['enable_cache_headers']) {
        sropt_write_htaccess_rules($sanitized);
    } else {
        sropt_remove_htaccess_rules();
    }

    // Clear all caches on settings save
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom/';
    if (file_exists($cache_dir)) {
        array_map('unlink', array_filter(glob("$cache_dir*.css"), 'is_file'));
        array_map('unlink', array_filter(glob("$cache_dir*.js"), 'is_file'));
    }
    $page_cache_dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (file_exists($page_cache_dir)) {
        array_map('unlink', array_filter(glob("$page_cache_dir*.html"), 'is_file'));
    }

    return $sanitized;
}

function sropt_settings_page() {
    $options = sropt_get_options();
    ?>
    <div class="wrap">
        <h1>SEO Room</h1>
        <p style="color:#666;">All-in-one SEO optimization. All changes are non-destructive — deactivate to instantly revert.</p>

        <form method="post" action="options.php">
            <?php settings_fields('sropt_group'); ?>

            <?php if ($options['safe_mode']): ?>
            <div style="background:#fff3cd;border:1px solid #ffc107;padding:12px 16px;border-radius:6px;margin-bottom:20px;">
                <strong>⚡ Safe Mode is ON</strong> — Only the safest optimizations are active (lazy load, font swap, preconnect, DNS prefetch, schema).
            </div>
            <?php endif; ?>

            <table class="form-table">
                <!-- SAFETY -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🛡️ Safety</h2></th></tr>
                <tr>
                    <th>Safe Mode</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[safe_mode]" value="1" <?php checked($options['safe_mode']); ?> /> Enable safe mode (only non-breaking optimizations)</label>
                        <p class="description">When enabled, CSS/JS minification and deferral are disabled. Schema, lazy load, fonts, and preconnect remain active.</p>
                    </td>
                </tr>

                <!-- SCHEMA -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">📋 Schema (JSON-LD)</h2></th></tr>
                <tr>
                    <th>Schema Injection</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_schema]" value="1" <?php checked($options['enable_schema']); ?> /> Output JSON-LD schema from <code>_seoroom_schema</code> post meta in &lt;head&gt;</label>
                        <p class="description">Works with any page builder (Elementor, Gutenberg, Classic). Schema is written by SEO Room Dashboard via REST API.</p>
                    </td>
                </tr>

                <!-- IMAGES -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🖼️ Images</h2></th></tr>
                <tr>
                    <th>Lazy Loading</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_lazy_load]" value="1" <?php checked($options['enable_lazy_load']); ?> /> Add loading="lazy" to images and iframes below the fold</label></td>
                </tr>
                <tr>
                    <th>Image Dimensions</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_image_dims]" value="1" <?php checked($options['enable_image_dims']); ?> /> Add missing width/height attributes to prevent CLS</label></td>
                </tr>

                <!-- CSS -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">📄 CSS</h2></th></tr>
                <tr>
                    <th>Minify CSS</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_css_minify]" value="1" <?php checked($options['enable_css_minify']); ?> /> Minify CSS output (removes comments and whitespace)</label></td>
                </tr>
                <tr>
                    <th>Defer Non-Critical CSS</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_css_defer]" value="1" <?php checked($options['enable_css_defer']); ?> /> Load non-critical CSS asynchronously</label>
                        <p class="description" style="color:#d63384;">⚠️ Can cause flash of unstyled content. Test carefully.</p>
                    </td>
                </tr>
                <tr>
                    <th>Exclude CSS</th>
                    <td>
                        <input type="text" name="sropt_options[exclude_css]" value="<?php echo esc_attr($options['exclude_css']); ?>" class="regular-text" />
                        <p class="description">Comma-separated CSS handles or filenames to exclude (e.g., <code>elementor-frontend,style</code>)</p>
                    </td>
                </tr>

                <!-- JS -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">⚡ JavaScript</h2></th></tr>
                <tr>
                    <th>Defer JS</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_js_defer]" value="1" <?php checked($options['enable_js_defer']); ?> /> Add defer attribute to non-critical scripts</label></td>
                </tr>
                <tr>
                    <th>Minify JS</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_js_minify]" value="1" <?php checked($options['enable_js_minify']); ?> /> Minify inline JavaScript (removes comments and whitespace)</label></td>
                </tr>
                <tr>
                    <th>Exclude JS</th>
                    <td>
                        <input type="text" name="sropt_options[exclude_js]" value="<?php echo esc_attr($options['exclude_js']); ?>" class="regular-text" />
                        <p class="description">Comma-separated JS handles or filenames to exclude (e.g., <code>jquery-core,elementor-frontend</code>)</p>
                    </td>
                </tr>

                <!-- PAGE CACHE -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🚀 Page Cache</h2></th></tr>
                <tr>
                    <th>HTML Page Cache</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_page_cache]" value="1" <?php checked($options['enable_page_cache']); ?> /> Cache full HTML pages to disk for instant delivery</label>
                        <p class="description">Bypasses PHP on cached pages. Huge TTFB improvement. Logged-in users always get fresh pages.</p>
                    </td>
                </tr>
                <tr>
                    <th>Cache Lifetime</th>
                    <td>
                        <select name="sropt_options[page_cache_ttl]">
                            <option value="3600" <?php selected($options['page_cache_ttl'], 3600); ?>>1 Hour</option>
                            <option value="21600" <?php selected($options['page_cache_ttl'], 21600); ?>>6 Hours</option>
                            <option value="43200" <?php selected($options['page_cache_ttl'], 43200); ?>>12 Hours</option>
                            <option value="86400" <?php selected($options['page_cache_ttl'], 86400); ?>>24 Hours (recommended)</option>
                            <option value="604800" <?php selected($options['page_cache_ttl'], 604800); ?>>7 Days</option>
                        </select>
                    </td>
                </tr>
                <tr>
                    <th>Exclude URLs</th>
                    <td>
                        <input type="text" name="sropt_options[cache_exclude_urls]" value="<?php echo esc_attr($options['cache_exclude_urls']); ?>" class="regular-text" />
                        <p class="description">Comma-separated URL paths to never cache (e.g., <code>/cart,/checkout,/my-account</code>)</p>
                    </td>
                </tr>

                <!-- WEBP -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🖼️ WebP Conversion</h2></th></tr>
                <tr>
                    <th>Serve WebP Images</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_webp]" value="1" <?php checked($options['enable_webp']); ?> /> Convert and serve images as WebP (50-70% smaller)</label>
                        <p class="description">Requires GD or Imagick PHP extension. Original images are untouched — WebP copies are cached separately.</p>
                    </td>
                </tr>
                <tr>
                    <th>WebP Quality</th>
                    <td>
                        <input type="number" name="sropt_options[webp_quality]" value="<?php echo esc_attr($options['webp_quality']); ?>" min="50" max="100" step="5" style="width:80px;" />
                        <p class="description">Quality 80 recommended. Lower = smaller files, less quality.</p>
                    </td>
                </tr>

                <!-- SERVER -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🌐 Server & Caching</h2></th></tr>
                <tr>
                    <th>GZIP Compression</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_gzip]" value="1" <?php checked($options['enable_gzip']); ?> /> Enable GZIP compression via .htaccess</label></td>
                </tr>
                <tr>
                    <th>Browser Cache Headers</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_cache_headers]" value="1" <?php checked($options['enable_cache_headers']); ?> /> Set long-lived cache headers for static assets via .htaccess</label></td>
                </tr>

                <!-- FONTS -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🔤 Fonts & Preloading</h2></th></tr>
                <tr>
                    <th>Font Display Swap</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_font_swap]" value="1" <?php checked($options['enable_font_swap']); ?> /> Add font-display:swap to prevent invisible text during font loading</label></td>
                </tr>
                <tr>
                    <th>Preconnect</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_preconnect]" value="1" <?php checked($options['enable_preconnect']); ?> /> Auto-detect and preconnect to external domains</label></td>
                </tr>
                <tr>
                    <th>DNS Prefetch</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_dns_prefetch]" value="1" <?php checked($options['enable_dns_prefetch']); ?> /> DNS prefetch for detected external domains</label></td>
                </tr>
            </table>

            <?php submit_button('Save & Apply'); ?>
        </form>

        <div style="margin-top:30px;padding:16px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;">
            <h3 style="margin-top:0;">Quick Actions</h3>
            <p>
                <a href="<?php echo wp_nonce_url(admin_url('admin-post.php?action=sropt_clear_cache'), 'sropt_clear_cache'); ?>" class="button">Clear All Caches</a>
                <a href="https://pagespeed.web.dev/analysis?url=<?php echo urlencode(home_url('/')); ?>" target="_blank" class="button">Test on PageSpeed Insights</a>
            </p>
            <?php
            $page_count = count(glob(WP_CONTENT_DIR . '/cache/seoroom/pages/*.html'));
            $webp_files = glob(WP_CONTENT_DIR . '/cache/seoroom/webp/**/*.webp') ?: array();
            $webp_count = count($webp_files);
            ?>
            <p style="color:#666;font-size:13px;margin-top:8px;">
                📄 Page cache: <strong><?php echo $page_count; ?></strong> cached pages
                &nbsp;|&nbsp;
                🖼️ WebP cache: <strong><?php echo $webp_count; ?></strong> converted images
            </p>
        </div>
    </div>
    <?php
}

// Clear cache action
add_action('admin_post_sropt_clear_cache', function() {
    check_admin_referer('sropt_clear_cache');
    // Clear minified CSS/JS
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom/';
    if (file_exists($cache_dir)) {
        $files = glob($cache_dir . '*.{css,js}', GLOB_BRACE);
        if ($files) array_map('unlink', $files);
    }
    // Clear page cache
    $page_dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (file_exists($page_dir)) {
        $files = glob($page_dir . '*.html');
        if ($files) array_map('unlink', $files);
    }
    // Clear WebP cache
    $webp_dir = WP_CONTENT_DIR . '/cache/seoroom/webp/';
    if (file_exists($webp_dir)) {
        $iter = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($webp_dir, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iter as $item) {
            if ($item->isFile()) @unlink($item->getPathname());
        }
    }
    wp_redirect(admin_url('options-general.php?page=seoroom&cleared=1'));
    exit;
});


// ================================================================
// SCHEMA INJECTION
// Reads _seoroom_schema post meta and outputs JSON-LD in <head>.
// Works with any page builder (Elementor, Gutenberg, Classic).
// ================================================================

// Register _seoroom_schema meta for REST API access (skip if seoroom-helper already registered it)
add_action('init', function() {
    if (registered_meta_key_exists('post', '_seoroom_schema', 'page')) return;
    foreach (['page', 'post'] as $type) {
        register_post_meta($type, '_seoroom_schema', [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function() { return current_user_can('edit_posts'); },
        ]);
    }
}, 20); // Priority 20 = after seoroom-helper

// Output JSON-LD in <head>
add_action('wp_head', 'sropt_output_schema', 5);
function sropt_output_schema() {
    $options = sropt_get_options();
    if (!$options['enable_schema']) return;
    if (!is_singular()) return;

    $post_id = get_the_ID();
    if (!$post_id) return;

    $schema = get_post_meta($post_id, '_seoroom_schema', true);
    if (empty($schema)) return;

    $decoded = json_decode($schema);
    if (json_last_error() !== JSON_ERROR_NONE) return;

    $clean = wp_json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if (!$clean) return;

    echo "\n<!-- SEO Room Schema -->\n";
    echo '<script type="application/ld+json">' . $clean . '</script>' . "\n";
}


// ================================================================
// IMAGE OPTIMIZATION
// ================================================================

// Lazy loading — skip first 2 images (above fold / LCP)
add_filter('the_content', 'sropt_lazy_load', 999);
add_filter('post_thumbnail_html', 'sropt_lazy_load', 999);
add_filter('widget_text', 'sropt_lazy_load', 999);

function sropt_lazy_load($content) {
    if (is_admin() || is_feed() || wp_doing_ajax()) return $content;
    $options = sropt_get_options();
    if (!$options['enable_lazy_load']) return $content;

    $count = 0;
    $skip_first = 2;

    $content = preg_replace_callback('/<img\b([^>]*)>/i', function($matches) use (&$count, $skip_first) {
        $count++;
        $attrs = $matches[1];
        if (preg_match('/\bloading\s*=/i', $attrs)) return $matches[0];

        if ($count <= $skip_first) {
            if ($count === 1 && !preg_match('/fetchpriority/i', $attrs)) {
                return '<img' . $attrs . ' fetchpriority="high">';
            }
            return $matches[0];
        }
        return '<img' . $attrs . ' loading="lazy">';
    }, $content);

    $content = preg_replace_callback('/<iframe\b([^>]*)>/i', function($matches) {
        $attrs = $matches[1];
        if (preg_match('/\bloading\s*=/i', $attrs)) return $matches[0];
        return '<iframe' . $attrs . ' loading="lazy">';
    }, $content);

    return $content;
}

// Add missing width/height to images to prevent CLS
add_filter('the_content', 'sropt_image_dimensions', 998);
function sropt_image_dimensions($content) {
    if (is_admin() || is_feed()) return $content;
    $options = sropt_get_options();
    if (!$options['enable_image_dims']) return $content;

    $content = preg_replace_callback('/<img\b([^>]*)>/i', function($matches) {
        $attrs = $matches[1];
        if (preg_match('/\bwidth\s*=/i', $attrs) && preg_match('/\bheight\s*=/i', $attrs)) return $matches[0];
        if (!preg_match('/\bsrc\s*=\s*["\']([^"\']+)["\']/i', $attrs, $src_match)) return $matches[0];

        $src = $src_match[1];
        $attachment_id = attachment_url_to_postid($src);
        if ($attachment_id) {
            $meta = wp_get_attachment_metadata($attachment_id);
            if ($meta && !empty($meta['width']) && !empty($meta['height'])) {
                $w = $meta['width'];
                $h = $meta['height'];
                if (preg_match('/-(\d+)x(\d+)\.\w+$/', $src, $size_match)) {
                    $w = $size_match[1];
                    $h = $size_match[2];
                }
                if (!preg_match('/\bwidth\s*=/i', $attrs)) $attrs .= ' width="' . $w . '"';
                if (!preg_match('/\bheight\s*=/i', $attrs)) $attrs .= ' height="' . $h . '"';
                return '<img' . $attrs . '>';
            }
        }
        return $matches[0];
    }, $content);

    return $content;
}


// ================================================================
// HTML OUTPUT BUFFER — CSS/JS minification, font-swap, preconnect
// ================================================================

add_action('template_redirect', 'sropt_start_buffer', 1);
function sropt_start_buffer() {
    if (is_admin() || is_feed() || wp_doing_ajax()) return;
    if (defined('DOING_CRON') && DOING_CRON) return;

    $options = sropt_get_options();
    $is_safe = $options['safe_mode'];

    $needs_buffer = (!$is_safe && ($options['enable_css_minify'] || $options['enable_js_minify']))
        || $options['enable_font_swap'] || $options['enable_preconnect'] || $options['enable_dns_prefetch'];

    if ($needs_buffer) ob_start('sropt_process_html');
}

function sropt_process_html($html) {
    if (empty($html) || strlen($html) < 100) return $html;
    if (stripos($html, '<html') === false && stripos($html, '<!DOCTYPE') === false) return $html;

    $options = sropt_get_options();
    $is_safe = $options['safe_mode'];

    // CSS minification (inline <style> blocks)
    if ($options['enable_css_minify'] && !$is_safe) {
        $html = preg_replace_callback('/<style\b([^>]*)>(.*?)<\/style>/is', function($m) {
            $css = $m[2];
            $css = preg_replace('!/\*.*?\*/!s', '', $css);
            $css = preg_replace('/\s+/', ' ', $css);
            $css = preg_replace('/\s*([{}:;,>~+])\s*/', '$1', $css);
            $css = preg_replace('/;}/', '}', $css);
            return '<style' . $m[1] . '>' . trim($css) . '</style>';
        }, $html);
    }

    // JS minification (inline <script> blocks only)
    if ($options['enable_js_minify'] && !$is_safe) {
        $html = preg_replace_callback('/<script\b([^>]*)>(.*?)<\/script>/is', function($m) {
            $attrs = $m[1];
            $js = $m[2];
            if (preg_match('/\bsrc\s*=/i', $attrs)) return $m[0];
            if (preg_match('/type\s*=\s*["\'](?:application\/(?:ld\+json|json)|text\/(?:template|html))/i', $attrs)) return $m[0];
            if (empty(trim($js))) return $m[0];
            $js = preg_replace('#^\s*//[^\n]*$#m', '', $js);
            $js = preg_replace('/\s+/', ' ', $js);
            return '<script' . $attrs . '>' . trim($js) . '</script>';
        }, $html);
    }

    // Font-display: swap
    if ($options['enable_font_swap']) {
        $html = preg_replace_callback('/@font-face\s*\{([^}]+)\}/i', function($m) {
            if (stripos($m[1], 'font-display') !== false) return $m[0];
            return '@font-face{' . rtrim($m[1], '; ') . ';font-display:swap;}';
        }, $html);

        $html = preg_replace_callback('/href\s*=\s*["\']([^"\']*fonts\.googleapis\.com[^"\']*)["\']/', function($m) {
            $url = $m[1];
            if (strpos($url, 'display=') !== false) return $m[0];
            $sep = strpos($url, '?') !== false ? '&' : '?';
            return str_replace($url, $url . $sep . 'display=swap', $m[0]);
        }, $html);
    }

    // Auto preconnect + DNS prefetch
    if ($options['enable_preconnect'] || $options['enable_dns_prefetch']) {
        $external_domains = array();
        $site_host = parse_url(home_url(), PHP_URL_HOST);

        preg_match_all('/(?:href|src)\s*=\s*["\']https?:\/\/([^"\'\/]+)/i', $html, $domain_matches);
        if (!empty($domain_matches[1])) {
            foreach ($domain_matches[1] as $domain) {
                $domain = strtolower($domain);
                if ($domain !== $site_host && !isset($external_domains[$domain])) {
                    $external_domains[$domain] = true;
                }
            }
        }

        $preconnect_priority = array(
            'fonts.googleapis.com', 'fonts.gstatic.com', 'www.googletagmanager.com',
            'www.google-analytics.com', 'cdnjs.cloudflare.com', 'ajax.googleapis.com',
            'maps.googleapis.com', 'www.google.com',
        );

        $tags = '';
        foreach ($external_domains as $domain => $v) {
            $url = 'https://' . $domain;
            if (preg_match('/rel\s*=\s*["\'](?:preconnect|dns-prefetch)["\'][^>]*' . preg_quote($domain, '/') . '/', $html)) continue;

            if ($options['enable_preconnect'] && in_array($domain, $preconnect_priority)) {
                $crossorigin = (strpos($domain, 'gstatic.com') !== false) ? ' crossorigin' : '';
                $tags .= '<link rel="preconnect" href="' . esc_url($url) . '"' . $crossorigin . '>' . "\n";
            }
            if ($options['enable_dns_prefetch']) {
                $tags .= '<link rel="dns-prefetch" href="' . esc_url($url) . '">' . "\n";
            }
        }

        if ($tags) {
            if (preg_match('/<meta[^>]*charset[^>]*>/i', $html, $meta_match, PREG_OFFSET_CAPTURE)) {
                $pos = $meta_match[0][1] + strlen($meta_match[0][0]);
                $html = substr($html, 0, $pos) . "\n" . $tags . substr($html, $pos);
            } elseif (($head_pos = stripos($html, '<head>')) !== false) {
                $pos = $head_pos + 6;
                $html = substr($html, 0, $pos) . "\n" . $tags . substr($html, $pos);
            }
        }
    }

    return $html;
}


// ================================================================
// JS OPTIMIZATION — DEFER/ASYNC
// ================================================================

add_filter('script_loader_tag', 'sropt_defer_js', 10, 3);
function sropt_defer_js($tag, $handle, $src) {
    if (is_admin()) return $tag;
    $options = sropt_get_options();
    if (!$options['enable_js_defer'] || $options['safe_mode']) return $tag;

    $never_defer = array('jquery-core', 'jquery', 'jquery-migrate', 'wp-polyfill', 'wp-hooks', 'wp-i18n', 'underscore', 'backbone');
    if (in_array($handle, $never_defer)) return $tag;

    $excludes = array_filter(array_map('trim', explode(',', $options['exclude_js'])));
    foreach ($excludes as $exc) {
        if ($handle === $exc || strpos($src, $exc) !== false) return $tag;
    }

    if (preg_match('/\b(defer|async)\b/i', $tag)) return $tag;

    return str_replace(' src=', ' defer src=', $tag);
}


// ================================================================
// CSS OPTIMIZATION — DEFER NON-CRITICAL
// ================================================================

add_filter('style_loader_tag', 'sropt_optimize_css_tag', 10, 4);
function sropt_optimize_css_tag($tag, $handle, $href, $media) {
    if (is_admin()) return $tag;
    $options = sropt_get_options();
    if ($options['safe_mode'] || !$options['enable_css_defer']) return $tag;

    $excludes = array_filter(array_map('trim', explode(',', $options['exclude_css'])));
    foreach ($excludes as $exc) {
        if ($handle === $exc || strpos($href, $exc) !== false) return $tag;
    }

    $never_defer_css = array(
        'wp-block-library', 'global-styles', 'theme-style', 'style',
        'elementor-frontend', 'elementor-common', 'elementor-icons',
        'astra-theme-css', 'generatepress',
    );
    if (in_array($handle, $never_defer_css)) return $tag;

    $tag = str_replace("media='all'", "media='print' onload=\"this.media='all'\"", $tag);
    $tag = str_replace('media="all"', 'media="print" onload="this.media=\'all\'"', $tag);
    return $tag;
}


// ================================================================
// HTACCESS — GZIP & BROWSER CACHE HEADERS
// ================================================================

function sropt_write_htaccess_rules($options = null) {
    if (!$options) $options = sropt_get_options();
    if (!function_exists('get_home_path')) require_once ABSPATH . 'wp-admin/includes/file.php';

    $htaccess_file = get_home_path() . '.htaccess';
    if (!file_exists($htaccess_file) || !is_writable($htaccess_file)) return false;

    $rules = "\n# BEGIN SEO Room\n";

    if ($options['enable_gzip']) {
        $rules .= "<IfModule mod_deflate.c>\n";
        $rules .= "  AddOutputFilterByType DEFLATE text/html text/plain text/xml text/css text/javascript\n";
        $rules .= "  AddOutputFilterByType DEFLATE application/javascript application/x-javascript application/json\n";
        $rules .= "  AddOutputFilterByType DEFLATE application/xml application/xhtml+xml application/rss+xml\n";
        $rules .= "  AddOutputFilterByType DEFLATE image/svg+xml image/x-icon\n";
        $rules .= "  AddOutputFilterByType DEFLATE font/ttf font/otf font/woff font/woff2\n";
        $rules .= "</IfModule>\n\n";
    }

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

    $rules .= "# END SEO Room\n";

    $existing = file_get_contents($htaccess_file);
    $existing = preg_replace('/\n?# BEGIN SEO Room\b.*?# END SEO Room\n?/s', '', $existing);

    if (($wp_pos = strpos($existing, '# BEGIN WordPress')) !== false) {
        $existing = substr($existing, 0, $wp_pos) . $rules . "\n" . substr($existing, $wp_pos);
    } else {
        $existing = $rules . "\n" . $existing;
    }

    file_put_contents($htaccess_file, $existing);
    return true;
}

function sropt_remove_htaccess_rules() {
    if (!function_exists('get_home_path')) require_once ABSPATH . 'wp-admin/includes/file.php';
    $htaccess_file = get_home_path() . '.htaccess';
    if (!file_exists($htaccess_file) || !is_writable($htaccess_file)) return;
    $existing = file_get_contents($htaccess_file);
    $existing = preg_replace('/\n?# BEGIN SEO Room\b.*?# END SEO Room\n?/s', '', $existing);
    file_put_contents($htaccess_file, $existing);
}

add_action('admin_init', function() {
    if (get_transient('sropt_htaccess_written')) return;
    $options = sropt_get_options();
    if ($options['enable_gzip'] || $options['enable_cache_headers']) {
        if (!function_exists('get_home_path')) require_once ABSPATH . 'wp-admin/includes/file.php';
        sropt_write_htaccess_rules($options);
        set_transient('sropt_htaccess_written', true, DAY_IN_SECONDS);
    }
});


// ================================================================
// PRELOAD LCP IMAGE
// ================================================================

add_action('wp_head', 'sropt_preload_hints', 1);
function sropt_preload_hints() {
    if (is_admin()) return;
    if (is_singular() && has_post_thumbnail()) {
        $thumb_id = get_post_thumbnail_id();
        $thumb_url = wp_get_attachment_image_url($thumb_id, 'large');
        if ($thumb_url) {
            echo '<link rel="preload" as="image" href="' . esc_url($thumb_url) . '">' . "\n";
        }
    }
}


// ================================================================
// REMOVE WORDPRESS BLOAT
// ================================================================

add_action('init', 'sropt_remove_bloat');
function sropt_remove_bloat() {
    if (is_admin()) return;

    remove_action('wp_head', 'print_emoji_detection_script', 7);
    remove_action('wp_print_styles', 'print_emoji_styles');
    remove_action('admin_print_scripts', 'print_emoji_detection_script');
    remove_action('admin_print_styles', 'print_emoji_styles');
    remove_action('wp_head', 'wlwmanifest_link');
    remove_action('wp_head', 'rsd_link');
    remove_action('wp_head', 'wp_generator');
    remove_action('wp_head', 'wp_shortlink_wp_head');

    add_action('pre_ping', function(&$links) {
        $home = home_url();
        foreach ($links as $l => $link) {
            if (strpos($link, $home) === 0) unset($links[$l]);
        }
    });
}

add_filter('emoji_svg_url', '__return_false');

// Remove jQuery Migrate
add_action('wp_default_scripts', function($scripts) {
    if (is_admin()) return;
    if (isset($scripts->registered['jquery'])) {
        $script = $scripts->registered['jquery'];
        if ($script->deps) {
            $script->deps = array_diff($script->deps, array('jquery-migrate'));
        }
    }
});


// ================================================================
// ADMIN BAR STATUS
// ================================================================

add_action('admin_bar_menu', 'sropt_admin_bar', 999);
function sropt_admin_bar($wp_admin_bar) {
    if (!current_user_can('manage_options')) return;
    $options = sropt_get_options();
    $status = $options['safe_mode'] ? '⚡ Safe' : '⚡ Active';
    $wp_admin_bar->add_node(array(
        'id'    => 'seoroom',
        'title' => 'SEO Room: ' . $status,
        'href'  => admin_url('options-general.php?page=seoroom'),
        'meta'  => array('title' => 'SEO Room — Speed + Schema'),
    ));
}


// ================================================================
// PAGE CACHE — Serve cached HTML, bypass PHP on repeat visits
// ================================================================

add_action('template_redirect', 'sropt_page_cache_serve', 0);
function sropt_page_cache_serve() {
    if (is_admin() || is_feed() || wp_doing_ajax()) return;
    if (defined('DOING_CRON') && DOING_CRON) return;
    if (is_user_logged_in()) return;
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') return;
    if (!empty($_GET)) return; // Don't cache URLs with query strings

    $options = sropt_get_options();
    if (!$options['enable_page_cache'] || $options['safe_mode']) return;

    // Check excluded URLs
    $request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $excludes = array_filter(array_map('trim', explode(',', $options['cache_exclude_urls'])));
    foreach ($excludes as $exc) {
        if (strpos($request_uri, $exc) !== false) return;
    }

    // Never cache these
    $never_cache = array('/wp-admin', '/wp-login', '/cart', '/checkout', '/my-account', '/wp-json', '/feed');
    foreach ($never_cache as $nc) {
        if (strpos($request_uri, $nc) !== false) return;
    }

    $cache_file = sropt_page_cache_path();
    if ($cache_file && file_exists($cache_file)) {
        $age = time() - filemtime($cache_file);
        if ($age < (int)$options['page_cache_ttl']) {
            header('X-SEORoom-Cache: HIT');
            header('X-SEORoom-Cache-Age: ' . $age . 's');
            readfile($cache_file);
            exit;
        } else {
            @unlink($cache_file); // Expired
        }
    }
}

function sropt_page_cache_path() {
    $uri = $_SERVER['REQUEST_URI'];
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $key = md5($host . $uri);
    $dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (!file_exists($dir)) wp_mkdir_p($dir);
    return $dir . $key . '.html';
}

// After the output buffer processes HTML, save to page cache
add_action('shutdown', 'sropt_page_cache_save', 999);
function sropt_page_cache_save() {
    if (is_admin() || is_user_logged_in()) return;
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') return;
    if (!empty($_GET)) return;

    $options = sropt_get_options();
    if (!$options['enable_page_cache'] || $options['safe_mode']) return;

    // Check if we already served from cache
    $headers = headers_list();
    foreach ($headers as $h) {
        if (stripos($h, 'X-SEORoom-Cache: HIT') !== false) return;
    }

    // Check excluded URLs
    $request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $excludes = array_filter(array_map('trim', explode(',', $options['cache_exclude_urls'])));
    foreach ($excludes as $exc) {
        if (strpos($request_uri, $exc) !== false) return;
    }
    $never_cache = array('/wp-admin', '/wp-login', '/cart', '/checkout', '/my-account', '/wp-json', '/feed');
    foreach ($never_cache as $nc) {
        if (strpos($request_uri, $nc) !== false) return;
    }

    // Check HTTP status code — only cache 200 responses
    $status = http_response_code();
    if ($status && $status !== 200) return;

    $cache_file = sropt_page_cache_path();
    if (!$cache_file) return;

    // Get the page content from output buffering
    $content = '';
    $levels = ob_get_level();
    if ($levels > 0) {
        $content = ob_get_contents();
    }

    if (empty($content) || strlen($content) < 200) return;
    if (stripos($content, '<html') === false) return;

    // Add cache signature
    $content .= "\n<!-- Cached by SEO Room v" . SEOROOM_VERSION . " at " . gmdate('Y-m-d H:i:s') . " UTC -->";
    @file_put_contents($cache_file, $content);
}

// Clear page cache when content is updated
add_action('save_post', 'sropt_clear_page_cache', 10, 1);
add_action('comment_post', 'sropt_clear_page_cache');
add_action('transition_comment_status', 'sropt_clear_page_cache');
function sropt_clear_page_cache($post_id = 0) {
    $dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (!file_exists($dir)) return;

    if ($post_id && is_numeric($post_id)) {
        // Clear specific page cache
        $url = get_permalink($post_id);
        if ($url) {
            $uri = parse_url($url, PHP_URL_PATH);
            $host = parse_url(home_url(), PHP_URL_HOST);
            $key = md5($host . $uri);
            $file = $dir . $key . '.html';
            if (file_exists($file)) @unlink($file);
        }
        // Also clear homepage
        $home_key = md5(parse_url(home_url(), PHP_URL_HOST) . '/');
        $home_file = $dir . $home_key . '.html';
        if (file_exists($home_file)) @unlink($home_file);
    } else {
        // Clear all
        $files = glob($dir . '*.html');
        if ($files) array_map('unlink', $files);
    }
}



// ================================================================
// WEBP IMAGE CONVERSION — Convert on-the-fly, cache to disk
// ================================================================

add_filter('the_content', 'sropt_webp_images', 997);
add_filter('post_thumbnail_html', 'sropt_webp_images', 997);
add_filter('widget_text', 'sropt_webp_images', 997);

function sropt_webp_images($content) {
    if (is_admin() || is_feed() || wp_doing_ajax()) return $content;
    $options = sropt_get_options();
    if (!$options['enable_webp']) return $content;

    // Check if GD or Imagick supports WebP
    if (!sropt_can_create_webp()) return $content;

    $content = preg_replace_callback('/<img\b([^>]*)\bsrc\s*=\s*["\']([^"\']+)["\']([^>]*)>/i', function($matches) use ($options) {
        $before = $matches[1];
        $src = $matches[2];
        $after = $matches[3];

        // Only convert local images (jpg, jpeg, png)
        if (!preg_match('/\.(jpe?g|png)(\?.*)?$/i', $src)) return $matches[0];
        $upload_dir = wp_upload_dir();
        $upload_url = $upload_dir['baseurl'];
        if (strpos($src, $upload_url) === false && strpos($src, '/wp-content/uploads/') === false) return $matches[0];

        $webp_url = sropt_get_webp_url($src, (int)$options['webp_quality']);
        if (!$webp_url) return $matches[0];

        // Also convert srcset if present
        $full_attrs = $before . ' src="' . $src . '"' . $after;
        $srcset_webp = '';
        if (preg_match('/\bsrcset\s*=\s*["\']([^"\']+)["\']/i', $full_attrs, $srcset_match)) {
            $srcset_entries = explode(',', $srcset_match[1]);
            $webp_entries = array();
            foreach ($srcset_entries as $entry) {
                $entry = trim($entry);
                $parts = preg_split('/\s+/', $entry);
                if (count($parts) >= 2 && preg_match('/\.(jpe?g|png)/i', $parts[0])) {
                    $w_url = sropt_get_webp_url($parts[0], (int)$options['webp_quality']);
                    if ($w_url) $parts[0] = $w_url;
                }
                $webp_entries[] = implode(' ', $parts);
            }
            $srcset_webp = implode(', ', $webp_entries);
        }

        // Build <picture> element with WebP source + original fallback
        $picture = '<picture>';
        if ($srcset_webp) {
            $picture .= '<source type="image/webp" srcset="' . esc_attr($srcset_webp) . '"';
            if (preg_match('/\bsizes\s*=\s*["\']([^"\']+)["\']/i', $full_attrs, $sizes_match)) {
                $picture .= ' sizes="' . esc_attr($sizes_match[1]) . '"';
            }
            $picture .= '>';
        } else {
            $picture .= '<source type="image/webp" srcset="' . esc_attr($webp_url) . '">';
        }
        $picture .= $matches[0]; // Original <img> as fallback
        $picture .= '</picture>';
        return $picture;
    }, $content);

    return $content;
}

function sropt_can_create_webp() {
    static $can = null;
    if ($can !== null) return $can;

    if (function_exists('imagewebp') && function_exists('imagecreatefromjpeg')) {
        $can = true;
    } elseif (class_exists('Imagick')) {
        $formats = Imagick::queryFormats('WEBP');
        $can = !empty($formats);
    } else {
        $can = false;
    }
    return $can;
}

function sropt_get_webp_url($src_url, $quality = 80) {
    // Convert URL to local path
    $upload_dir = wp_upload_dir();
    $upload_url = $upload_dir['baseurl'];
    $upload_path = $upload_dir['basedir'];

    if (strpos($src_url, $upload_url) !== false) {
        $relative = str_replace($upload_url, '', $src_url);
    } elseif (preg_match('#/wp-content/uploads/(.+)#', $src_url, $m)) {
        $relative = '/' . $m[1];
    } else {
        return false;
    }

    // Remove query string
    $relative = preg_replace('/\?.*$/', '', $relative);
    $src_path = $upload_path . $relative;
    if (!file_exists($src_path)) return false;

    // WebP cache path
    $webp_relative = preg_replace('/\.(jpe?g|png)$/i', '.webp', $relative);
    $webp_dir = WP_CONTENT_DIR . '/cache/seoroom/webp';
    $webp_path = $webp_dir . $webp_relative;

    // Check if cached WebP exists and is newer than source
    if (file_exists($webp_path) && filemtime($webp_path) >= filemtime($src_path)) {
        return content_url('/cache/seoroom/webp' . $webp_relative);
    }

    // Create WebP
    $webp_subdir = dirname($webp_path);
    if (!file_exists($webp_subdir)) wp_mkdir_p($webp_subdir);

    $ext = strtolower(pathinfo($src_path, PATHINFO_EXTENSION));
    $created = false;

    if (function_exists('imagewebp')) {
        // GD library
        if ($ext === 'png') {
            $img = @imagecreatefrompng($src_path);
            if ($img) {
                imagepalettetotruecolor($img);
                imagealphablending($img, true);
                imagesavealpha($img, true);
            }
        } else {
            $img = @imagecreatefromjpeg($src_path);
        }
        if ($img) {
            $created = @imagewebp($img, $webp_path, $quality);
            imagedestroy($img);
        }
    } elseif (class_exists('Imagick')) {
        try {
            $im = new Imagick($src_path);
            $im->setImageFormat('webp');
            $im->setImageCompressionQuality($quality);
            $created = $im->writeImage($webp_path);
            $im->clear();
            $im->destroy();
        } catch (Exception $e) {
            $created = false;
        }
    }

    if (!$created || !file_exists($webp_path)) return false;

    // Only use WebP if it's actually smaller
    if (filesize($webp_path) >= filesize($src_path)) {
        @unlink($webp_path);
        return false;
    }

    return content_url('/cache/seoroom/webp' . $webp_relative);
}


// ================================================================
// REST API STATUS ENDPOINT
// ================================================================

add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/status', array(
        'methods'  => 'GET',
        'callback' => function() {
            $options = sropt_get_options();
            $is_safe = $options['safe_mode'];
            return new WP_REST_Response(array(
                'active'    => true,
                'version'   => SEOROOM_VERSION,
                'safe_mode' => $is_safe,
                'features'  => array(
                    'schema'        => $options['enable_schema'],
                    'lazy_load'     => $options['enable_lazy_load'],
                    'image_dims'    => $options['enable_image_dims'],
                    'css_minify'    => $options['enable_css_minify'] && !$is_safe,
                    'css_defer'     => $options['enable_css_defer'] && !$is_safe,
                    'js_defer'      => $options['enable_js_defer'] && !$is_safe,
                    'js_minify'     => $options['enable_js_minify'] && !$is_safe,
                    'gzip'          => $options['enable_gzip'],
                    'cache_headers' => $options['enable_cache_headers'],
                    'font_swap'     => $options['enable_font_swap'],
                    'preconnect'    => $options['enable_preconnect'],
                    'dns_prefetch'  => $options['enable_dns_prefetch'],
                    'page_cache'    => $options['enable_page_cache'] && !$is_safe,
                    'webp'          => $options['enable_webp'],
                ),
            ), 200);
        },
        'permission_callback' => '__return_true',
    ));
});
