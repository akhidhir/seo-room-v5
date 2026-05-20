<?php
/**
 * Plugin Name: SEO Room
 * Plugin URI: https://theseoroom.com.au
 * Description: All-in-one SEO optimization — automatic speed optimization (lazy loading, critical CSS, image compression, CSS/JS minification, browser caching, GZIP, font optimization, preconnect, LCP preload) + JSON-LD schema injection. Safe, non-destructive, instant revert on deactivation.
 * Version: 5.2.0
 * Author: The SEO Room
 * Author URI: https://theseoroom.com.au
 * License: GPL v2 or later
 * Text Domain: seoroom
 */

if (!defined('ABSPATH')) exit;

define('SEOROOM_VERSION', '5.2.0');
define('SEOROOM_PATH', plugin_dir_path(__FILE__));
define('SEOROOM_URL', plugin_dir_url(__FILE__));

// ============ DEFAULT OPTIONS ============
function sropt_defaults() {
    return array(
        // Speed
        'enable_lazy_load'     => true,
        'enable_image_dims'    => true,
        'enable_css_minify'    => true,
        'enable_critical_css'  => true,
        'enable_css_defer'     => false, // Legacy — critical CSS handles deferral when enabled
        'enable_js_defer'      => true,
        'enable_js_delay'      => true,
        'enable_js_minify'     => true,
        'enable_gzip'          => true,
        'enable_cache_headers' => true,
        'enable_font_swap'     => true,
        'enable_preconnect'    => true,
        'enable_dns_prefetch'  => true,
        'enable_lcp_preload'   => true,
        'safe_mode'            => false,
        'exclude_css'          => '',
        'exclude_js'           => '',
        'cache_ttl'            => 604800,
        // Image Compression
        'enable_image_compress' => true,
        'image_compress_quality' => 82,
        // Page Cache
        'enable_page_cache'    => true,
        'page_cache_ttl'       => 86400,
        'cache_exclude_urls'   => '',
        // WebP
        'enable_webp'          => true,
        'webp_quality'         => 80,
        // SEO Tools
        'enable_404_monitor'   => true,
        'enable_redirects'     => true,
        'enable_link_checker'  => false, // Manual trigger only
        // Schema
        'enable_schema'        => true,
        // Dashboard Connection
        'dashboard_url'        => 'https://seo-room-v5-production.up.railway.app',
        'project_id'           => '',
        'connection_code'      => '',
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

    // Clear critical CSS cache on upgrade so new extraction logic takes effect
    $prev_ver = get_option('sropt_version', '0');
    if (version_compare($prev_ver, SEOROOM_VERSION, '<')) {
        $critical_dir = WP_CONTENT_DIR . '/cache/seoroom/critical/';
        if (is_dir($critical_dir)) {
            $files = glob($critical_dir . '*');
            if ($files) foreach ($files as $f) @unlink($f);
        }
        update_option('sropt_version', SEOROOM_VERSION);
    }

    $dirs = array(
        WP_CONTENT_DIR . '/cache/seoroom/',
        WP_CONTENT_DIR . '/cache/seoroom/pages/',
        WP_CONTENT_DIR . '/cache/seoroom/webp/',
        WP_CONTENT_DIR . '/cache/seoroom/critical/',
    );
    foreach ($dirs as $dir) {
        if (!file_exists($dir)) wp_mkdir_p($dir);
    }

    // Create DB tables for 404 monitor, redirects, link checker
    global $wpdb;
    $charset = $wpdb->get_charset_collate();

    $wpdb->query("CREATE TABLE IF NOT EXISTS {$wpdb->prefix}seoroom_404s (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        url VARCHAR(2048) NOT NULL,
        url_hash CHAR(32) NOT NULL,
        referrer VARCHAR(2048) DEFAULT '',
        user_agent VARCHAR(512) DEFAULT '',
        hit_count INT UNSIGNED DEFAULT 1,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY url_hash (url_hash),
        KEY last_seen (last_seen)
    ) $charset");

    $wpdb->query("CREATE TABLE IF NOT EXISTS {$wpdb->prefix}seoroom_redirects (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        source_url VARCHAR(2048) NOT NULL,
        source_hash CHAR(32) NOT NULL,
        target_url VARCHAR(2048) NOT NULL,
        redirect_type SMALLINT DEFAULT 301,
        hit_count INT UNSIGNED DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY source_hash (source_hash)
    ) $charset");

    $wpdb->query("CREATE TABLE IF NOT EXISTS {$wpdb->prefix}seoroom_broken_links (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        source_url VARCHAR(2048) NOT NULL,
        source_post_id BIGINT UNSIGNED DEFAULT 0,
        target_url VARCHAR(2048) NOT NULL,
        status_code SMALLINT DEFAULT 0,
        anchor_text VARCHAR(512) DEFAULT '',
        link_type VARCHAR(20) DEFAULT 'internal',
        scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY source_post (source_post_id),
        KEY status_code (status_code)
    ) $charset");

    flush_rewrite_rules();
}

register_deactivation_hook(__FILE__, 'sropt_deactivate');
function sropt_deactivate() {
    $dirs = array(
        WP_CONTENT_DIR . '/cache/seoroom/critical/',
        WP_CONTENT_DIR . '/cache/seoroom/pages/',
        WP_CONTENT_DIR . '/cache/seoroom/webp/',
        WP_CONTENT_DIR . '/cache/seoroom/',
    );
    foreach ($dirs as $dir) {
        if (file_exists($dir)) {
            $iter = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
                RecursiveIteratorIterator::CHILD_FIRST
            );
            foreach ($iter as $item) {
                if ($item->isFile()) @unlink($item->getPathname());
                elseif ($item->isDir()) @rmdir($item->getPathname());
            }
            @rmdir($dir);
        }
    }
    sropt_remove_htaccess_rules();
    flush_rewrite_rules();
}

// ============ PLUGIN ACTION LINKS (Settings link on Plugins page) ============
add_filter('plugin_action_links_' . plugin_basename(__FILE__), function($links) {
    $settings_link = '<a href="' . admin_url('options-general.php?page=seoroom') . '">Settings</a>';
    array_unshift($links, $settings_link);
    return $links;
});

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
    sropt_clear_all_caches();

    return $sanitized;
}

function sropt_clear_all_caches() {
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom/';
    if (file_exists($cache_dir)) {
        array_map('unlink', array_filter(glob("$cache_dir*.css"), 'is_file'));
        array_map('unlink', array_filter(glob("$cache_dir*.js"), 'is_file'));
    }
    $page_dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (file_exists($page_dir)) {
        array_map('unlink', array_filter(glob("$page_dir*.html"), 'is_file'));
    }
    $critical_dir = WP_CONTENT_DIR . '/cache/seoroom/critical/';
    if (file_exists($critical_dir)) {
        array_map('unlink', array_filter(glob("$critical_dir*.css"), 'is_file'));
    }
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
                <!-- DASHBOARD CONNECTION -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🔗 Dashboard Connection</h2></th></tr>
                <tr>
                    <th>Project ID</th>
                    <td>
                        <input type="number" name="sropt_options[project_id]" id="sropt_project_id" value="<?php echo esc_attr($options['project_id']); ?>" min="1" step="1" style="width:100px;" />
                        <p class="description">Your project ID from SEO Room Dashboard → Settings → Projects.</p>
                    </td>
                </tr>
                <tr>
                    <th>Dashboard URL</th>
                    <td>
                        <input type="url" name="sropt_options[dashboard_url]" id="sropt_dashboard_url" value="<?php echo esc_attr($options['dashboard_url']); ?>" class="regular-text" />
                        <p class="description">Your SEO Room Dashboard URL.</p>
                    </td>
                </tr>
                <tr>
                    <th>Connection Code</th>
                    <td>
                        <input type="text" name="sropt_options[connection_code]" id="sropt_connection_code" value="<?php echo esc_attr($options['connection_code']); ?>" class="regular-text" placeholder="Paste code from Dashboard → Project Settings" />
                        <p class="description">Generated in SEO Room Dashboard → Project Settings → Plugin Connection Code.</p>
                    </td>
                </tr>
                <tr>
                    <th>Status</th>
                    <td>
                        <span id="sropt_connection_status">
                            <?php if ($options['project_id'] && $options['connection_code']): ?>
                                <span style="color:#22c55e;font-weight:600;">● Connected</span>
                                <span style="color:#666;margin-left:8px;">Project #<?php echo esc_html($options['project_id']); ?></span>
                            <?php elseif ($options['project_id']): ?>
                                <span style="color:#f59e0b;font-weight:600;">● Missing connection code</span>
                            <?php else: ?>
                                <span style="color:#f59e0b;font-weight:600;">● Not configured</span>
                            <?php endif; ?>
                        </span>
                        <br><br>
                        <button type="button" id="sropt_test_connection" class="button button-secondary">Test Connection</button>
                        <button type="button" id="sropt_push_now" class="button button-primary" style="margin-left:8px;">Push Data Now</button>
                        <span id="sropt_test_result" style="margin-left:10px;"></span>
                        <?php
                        $last_push = get_option('sropt_last_push');
                        if ($last_push): ?>
                            <br><br>
                            <span style="color:#666;font-size:12px;">
                                Last push: <?php echo esc_html($last_push['time'] ?? '—'); ?> —
                                <?php if (($last_push['status'] ?? '') === 'ok'): ?>
                                    <span style="color:#22c55e;">✓ <?php echo intval($last_push['pages'] ?? 0); ?> pages sent</span>
                                <?php else: ?>
                                    <span style="color:#ef4444;">✗ <?php echo esc_html($last_push['error'] ?? 'Unknown error'); ?></span>
                                <?php endif; ?>
                            </span>
                        <?php endif; ?>
                        <script>
                        document.getElementById('sropt_test_connection').addEventListener('click', function() {
                            var btn = this;
                            var result = document.getElementById('sropt_test_result');
                            var url = document.getElementById('sropt_dashboard_url').value.replace(/\/$/, '');
                            var pid = document.getElementById('sropt_project_id').value;
                            var code = document.getElementById('sropt_connection_code').value;

                            if (!url || !pid || !code) {
                                result.innerHTML = '<span style="color:#ef4444;">Fill in all fields first.</span>';
                                return;
                            }

                            btn.disabled = true;
                            result.innerHTML = '<span style="color:#666;">Testing...</span>';

                            fetch(url + '/api/projects/' + pid + '/plugin-verify', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ code: code, site_url: '<?php echo esc_url(home_url()); ?>', plugin_version: '<?php echo SEOROOM_VERSION; ?>' })
                            })
                            .then(function(r) { return r.json(); })
                            .then(function(data) {
                                if (data.ok) {
                                    result.innerHTML = '<span style="color:#22c55e;font-weight:600;">✓ Connected to ' + (data.project_name || 'Project #' + pid) + '</span>';
                                    document.getElementById('sropt_connection_status').innerHTML = '<span style="color:#22c55e;font-weight:600;">● Connected</span> <span style="color:#666;margin-left:8px;">' + (data.project_name || 'Project #' + pid) + '</span>';
                                } else {
                                    result.innerHTML = '<span style="color:#ef4444;">✗ ' + (data.error || 'Invalid code or project ID') + '</span>';
                                }
                            })
                            .catch(function(e) {
                                result.innerHTML = '<span style="color:#ef4444;">✗ Could not reach dashboard: ' + e.message + '</span>';
                            })
                            .finally(function() { btn.disabled = false; });
                        });

                        document.getElementById('sropt_push_now').addEventListener('click', function() {
                            var btn = this;
                            var result = document.getElementById('sropt_test_result');
                            btn.disabled = true;
                            result.innerHTML = '<span style="color:#666;">Pushing page data to dashboard...</span>';

                            fetch('<?php echo esc_url(rest_url('seoroom-opt/v1/push-now')); ?>', {
                                method: 'POST',
                                headers: { 'X-WP-Nonce': '<?php echo wp_create_nonce('wp_rest'); ?>' },
                            })
                            .then(function(r) { return r.json(); })
                            .then(function(data) {
                                if (data.ok) {
                                    var pages = data.result && data.result.pages ? data.result.pages : '?';
                                    result.innerHTML = '<span style="color:#22c55e;font-weight:600;">✓ Pushed ' + pages + ' pages to dashboard</span>';
                                } else {
                                    result.innerHTML = '<span style="color:#ef4444;">✗ ' + (data.error || 'Push failed') + '</span>';
                                }
                            })
                            .catch(function(e) {
                                result.innerHTML = '<span style="color:#ef4444;">✗ Push error: ' + e.message + '</span>';
                            })
                            .finally(function() { btn.disabled = false; });
                        });
                        </script>
                    </td>
                </tr>

                <!-- SAFETY -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🛡️ Safety</h2></th></tr>
                <tr>
                    <th>Safe Mode</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[safe_mode]" value="1" <?php checked($options['safe_mode']); ?> /> Enable safe mode (only non-breaking optimizations)</label>
                        <p class="description">When enabled, CSS/JS minification, deferral, and critical CSS are disabled. Schema, lazy load, fonts, and preconnect remain active.</p>
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
                <tr>
                    <th>Image Compression</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_image_compress]" value="1" <?php checked($options['enable_image_compress']); ?> /> Compress images on upload (lossless EXIF strip + lossy quality reduction)</label>
                        <p class="description">Compresses JPEG/PNG on upload. Original quality preserved in WordPress revision. Works alongside WebP conversion.</p>
                    </td>
                </tr>
                <tr>
                    <th>JPEG Quality</th>
                    <td>
                        <input type="number" name="sropt_options[image_compress_quality]" value="<?php echo esc_attr($options['image_compress_quality']); ?>" min="60" max="95" step="1" style="width:80px;" />
                        <p class="description">JPEG compression quality (82 recommended). Lower = smaller files, less quality. PNG uses lossless optimization.</p>
                    </td>
                </tr>
                <tr>
                    <th>LCP Image Preload</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_lcp_preload]" value="1" <?php checked($options['enable_lcp_preload']); ?> /> Auto-detect and preload the largest contentful paint image</label>
                        <p class="description">Adds &lt;link rel="preload"&gt; for the hero/banner image. Reduces LCP time by 200-500ms.</p>
                    </td>
                </tr>

                <!-- CRITICAL CSS -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">⚡ Critical CSS</h2></th></tr>
                <tr>
                    <th>Critical CSS Inlining</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_critical_css]" value="1" <?php checked($options['enable_critical_css']); ?> /> Extract and inline above-the-fold CSS, defer the rest</label>
                        <p class="description">Generates critical CSS per page, inlines it in &lt;head&gt;, and safely defers all other stylesheets. Eliminates render-blocking CSS. <strong>Biggest single performance improvement (10-15 points).</strong></p>
                    </td>
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
                        <label><input type="checkbox" name="sropt_options[enable_css_defer]" value="1" <?php checked($options['enable_css_defer']); ?> /> Load non-critical CSS asynchronously (legacy — use Critical CSS instead)</label>
                        <p class="description" style="color:#d63384;">⚠️ Only needed if Critical CSS is off. Can cause FOUC without critical CSS inlining.</p>
                    </td>
                </tr>
                <tr>
                    <th>Exclude CSS</th>
                    <td>
                        <input type="text" name="sropt_options[exclude_css]" value="<?php echo esc_attr($options['exclude_css']); ?>" class="regular-text" />
                        <p class="description">Comma-separated CSS handles or filenames to exclude from deferral (e.g., <code>elementor-frontend,style</code>)</p>
                    </td>
                </tr>

                <!-- JS -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">⚡ JavaScript</h2></th></tr>
                <tr>
                    <th>Defer JS</th>
                    <td><label><input type="checkbox" name="sropt_options[enable_js_defer]" value="1" <?php checked($options['enable_js_defer']); ?> /> Add defer attribute to non-critical scripts</label></td>
                </tr>
                <tr>
                    <th>Delay JS Until Interaction</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_js_delay]" value="1" <?php checked($options['enable_js_delay']); ?> /> Don't execute JavaScript until user interacts (scroll, click, touch)</label>
                        <p class="description"><strong>Biggest TBT improvement.</strong> Scripts load only when the user scrolls, clicks, or touches the page. Reduces Total Blocking Time to near zero. Used by WP Rocket, FlyingPress, etc.</p>
                    </td>
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

                <!-- SEO TOOLS -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🔍 SEO Tools</h2></th></tr>
                <tr>
                    <th>404 Monitor</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_404_monitor]" value="1" <?php checked($options['enable_404_monitor']); ?> /> Log 404 errors with URL, referrer, and hit count</label>
                        <p class="description">Tracks every 404 hit. View and manage in SEO Room Dashboard or via REST API.</p>
                    </td>
                </tr>
                <tr>
                    <th>Redirects</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_redirects]" value="1" <?php checked($options['enable_redirects']); ?> /> Enable 301/302 redirect manager</label>
                        <p class="description">Create redirects from 404s or manually. Fires before WordPress loads the page for zero overhead.</p>
                    </td>
                </tr>
                <tr>
                    <th>404s Logged</th>
                    <td>
                        <?php
                        global $wpdb;
                        $t404 = $wpdb->prefix . 'seoroom_404s';
                        $count_404 = $wpdb->get_var("SELECT COUNT(*) FROM $t404");
                        $count_redirects = $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}seoroom_redirects");
                        ?>
                        <span style="font-size:14px;">📊 <strong><?php echo intval($count_404); ?></strong> unique 404 URLs &nbsp;|&nbsp; ↗️ <strong><?php echo intval($count_redirects); ?></strong> active redirects</span>
                        <br><br>
                        <a href="<?php echo wp_nonce_url(admin_url('admin-post.php?action=sropt_clear_404s'), 'sropt_clear_404s'); ?>" class="button button-small">Clear 404 Log</a>
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
            $page_count = count(glob(WP_CONTENT_DIR . '/cache/seoroom/pages/*.html') ?: array());
            $webp_count = 0;
            $webp_dir = WP_CONTENT_DIR . '/cache/seoroom/webp/';
            if (file_exists($webp_dir)) {
                $iter = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($webp_dir, RecursiveDirectoryIterator::SKIP_DOTS));
                foreach ($iter as $f) { if ($f->isFile() && pathinfo($f, PATHINFO_EXTENSION) === 'webp') $webp_count++; }
            }
            $critical_count = count(glob(WP_CONTENT_DIR . '/cache/seoroom/critical/*.css') ?: array());
            ?>
            <p style="color:#666;font-size:13px;margin-top:8px;">
                📄 Page cache: <strong><?php echo $page_count; ?></strong> cached pages
                &nbsp;|&nbsp;
                🖼️ WebP cache: <strong><?php echo $webp_count; ?></strong> converted images
                &nbsp;|&nbsp;
                ⚡ Critical CSS: <strong><?php echo $critical_count; ?></strong> cached pages
            </p>
        </div>
    </div>
    <?php
}

// Clear cache action
add_action('admin_post_sropt_clear_cache', function() {
    check_admin_referer('sropt_clear_cache');
    sropt_clear_all_caches();
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


// Clear 404 log action
add_action('admin_post_sropt_clear_404s', function() {
    check_admin_referer('sropt_clear_404s');
    global $wpdb;
    $wpdb->query("TRUNCATE TABLE {$wpdb->prefix}seoroom_404s");
    wp_redirect(admin_url('options-general.php?page=seoroom&cleared_404s=1'));
    exit;
});


// ================================================================
// SCHEMA INJECTION
// Reads _seoroom_schema post meta and outputs JSON-LD in <head>.
// Works with any page builder (Elementor, Gutenberg, Classic).
// ================================================================

// Register _seoroom_schema meta for REST API access (skip if seoroom-helper already registered it)
add_action('init', function() {
    // Auto-clear critical CSS cache on version upgrade (covers auto-updates)
    $prev_ver = get_option('sropt_version', '0');
    if (version_compare($prev_ver, SEOROOM_VERSION, '<')) {
        $critical_dir = WP_CONTENT_DIR . '/cache/seoroom/critical/';
        if (is_dir($critical_dir)) {
            $files = glob($critical_dir . '*');
            if ($files) foreach ($files as $f) @unlink($f);
        }
        update_option('sropt_version', SEOROOM_VERSION);
    }

    if (registered_meta_key_exists('post', '_seoroom_schema', 'page')) return;
    foreach (['page', 'post'] as $type) {
        register_post_meta($type, '_seoroom_schema', [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function() { return current_user_can('edit_posts'); },
        ]);
    }
}, 20);

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
// IMAGE COMPRESSION ON UPLOAD
// Compress JPEG/PNG on upload — strip EXIF, reduce quality.
// Non-destructive: WP keeps original in revision history.
// ================================================================

add_filter('wp_handle_upload', 'sropt_compress_uploaded_image');
function sropt_compress_uploaded_image($upload) {
    $options = sropt_get_options();
    if (!$options['enable_image_compress']) return $upload;

    $file = $upload['file'];
    $type = $upload['type'] ?? '';

    if ($type === 'image/jpeg' || $type === 'image/jpg') {
        sropt_compress_jpeg($file, (int)$options['image_compress_quality']);
    } elseif ($type === 'image/png') {
        sropt_compress_png($file);
    }

    return $upload;
}

function sropt_compress_jpeg($file, $quality = 82) {
    if (!function_exists('imagecreatefromjpeg')) return false;

    $img = @imagecreatefromjpeg($file);
    if (!$img) return false;

    // Strip EXIF by re-encoding (imagecreatefromjpeg doesn't preserve EXIF)
    // Save with target quality
    $result = @imagejpeg($img, $file, $quality);
    imagedestroy($img);
    return $result;
}

function sropt_compress_png($file) {
    if (!function_exists('imagecreatefrompng')) return false;

    $img = @imagecreatefrompng($file);
    if (!$img) return false;

    // Preserve transparency
    imagealphablending($img, false);
    imagesavealpha($img, true);

    // PNG compression level 6 (0=none, 9=max compression)
    // Level 6 is good balance of speed vs size
    $result = @imagepng($img, $file, 6);
    imagedestroy($img);
    return $result;
}

// Also compress generated thumbnails/sizes
add_filter('wp_generate_attachment_metadata', 'sropt_compress_thumbnails', 10, 2);
function sropt_compress_thumbnails($metadata, $attachment_id) {
    $options = sropt_get_options();
    if (!$options['enable_image_compress']) return $metadata;

    $upload_dir = wp_upload_dir();
    $base_dir = $upload_dir['basedir'];
    $file_dir = dirname($metadata['file']);

    if (!empty($metadata['sizes'])) {
        foreach ($metadata['sizes'] as $size => $data) {
            $file_path = $base_dir . '/' . $file_dir . '/' . $data['file'];
            if (!file_exists($file_path)) continue;

            $mime = $data['mime-type'] ?? '';
            if ($mime === 'image/jpeg' || $mime === 'image/jpg') {
                sropt_compress_jpeg($file_path, (int)$options['image_compress_quality']);
            } elseif ($mime === 'image/png') {
                sropt_compress_png($file_path);
            }
        }
    }

    return $metadata;
}


// ================================================================
// HTML OUTPUT BUFFER — Critical CSS, CSS/JS minification, font-swap, preconnect
// ================================================================

add_action('template_redirect', 'sropt_start_buffer', 1);
function sropt_start_buffer() {
    if (is_admin() || is_feed() || wp_doing_ajax()) return;
    if (defined('DOING_CRON') && DOING_CRON) return;

    $options = sropt_get_options();
    $is_safe = $options['safe_mode'];

    $needs_buffer = (!$is_safe && ($options['enable_css_minify'] || $options['enable_js_minify'] || $options['enable_critical_css']))
        || $options['enable_font_swap'] || $options['enable_preconnect'] || $options['enable_dns_prefetch'];

    if ($needs_buffer) ob_start('sropt_process_html');
}

function sropt_process_html($html) {
    if (empty($html) || strlen($html) < 100) return $html;
    if (stripos($html, '<html') === false && stripos($html, '<!DOCTYPE') === false) return $html;

    $options = sropt_get_options();
    $is_safe = $options['safe_mode'];

    // ---- CRITICAL CSS INJECTION ----
    if ($options['enable_critical_css'] && !$is_safe) {
        $html = sropt_inject_critical_css($html, $options);
    }

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
// CRITICAL CSS — Extract above-fold CSS, inline in <head>, defer rest
// ================================================================

function sropt_inject_critical_css($html, $options) {
    // Generate a cache key from the request URI
    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    $cache_key = md5(($_SERVER['HTTP_HOST'] ?? '') . $uri);
    $cache_dir = WP_CONTENT_DIR . '/cache/seoroom/critical/';
    $cache_file = $cache_dir . $cache_key . '.css';

    // Check if we have cached critical CSS
    $critical_css = '';
    if (file_exists($cache_file) && (time() - filemtime($cache_file)) < 604800) { // 7-day TTL
        $critical_css = file_get_contents($cache_file);
    }

    if (empty($critical_css)) {
        // Generate critical CSS from stylesheets in the HTML
        $critical_css = sropt_generate_critical_css($html);

        // Cache it
        if (!file_exists($cache_dir)) wp_mkdir_p($cache_dir);
        if (!empty($critical_css)) {
            @file_put_contents($cache_file, $critical_css);
        }
    }

    if (empty($critical_css)) return $html;

    // Minify the critical CSS
    $critical_css = preg_replace('!/\*.*?\*/!s', '', $critical_css);
    $critical_css = preg_replace('/\s+/', ' ', $critical_css);
    $critical_css = preg_replace('/\s*([{}:;,>~+])\s*/', '$1', $critical_css);
    $critical_css = preg_replace('/;}/', '}', $critical_css);
    $critical_css = trim($critical_css);

    // Cap at 60KB to avoid bloating HTML
    if (strlen($critical_css) > 40960) {
        $critical_css = substr($critical_css, 0, 40960);
        // Find the last complete rule
        $last_brace = strrpos($critical_css, '}');
        if ($last_brace !== false) $critical_css = substr($critical_css, 0, $last_brace + 1);
    }

    // Inject critical CSS inline in <head>
    $critical_tag = "\n<style id=\"seoroom-critical-css\">" . $critical_css . "</style>\n";

    // Find insertion point — after <meta charset> or right after <head>
    if (preg_match('/<meta[^>]*charset[^>]*>/i', $html, $meta_match, PREG_OFFSET_CAPTURE)) {
        $pos = $meta_match[0][1] + strlen($meta_match[0][0]);
        $html = substr($html, 0, $pos) . $critical_tag . substr($html, $pos);
    } elseif (($head_pos = stripos($html, '<head>')) !== false) {
        $pos = $head_pos + 6;
        $html = substr($html, 0, $pos) . $critical_tag . substr($html, $pos);
    }

    // Defer non-critical stylesheets — convert <link rel="stylesheet"> to async loading
    $excludes = array_filter(array_map('trim', explode(',', $options['exclude_css'])));
    $never_defer_css = array('admin-bar', 'dashicons', 'wp-admin');

    $html = preg_replace_callback('/<link\b([^>]*rel\s*=\s*["\']stylesheet["\'][^>]*)>/i', function($matches) use ($excludes, $never_defer_css) {
        $attrs = $matches[1];

        // Extract handle/href for exclusion checking
        $href = '';
        if (preg_match('/href\s*=\s*["\']([^"\']+)["\']/i', $attrs, $href_match)) {
            $href = $href_match[1];
        }
        $handle = '';
        if (preg_match('/id\s*=\s*["\']([^"\']+)-css["\']/i', $attrs, $id_match)) {
            $handle = $id_match[1];
        }

        // Check exclusions
        if (in_array($handle, $never_defer_css)) return $matches[0];
        foreach ($excludes as $exc) {
            if ($handle === $exc || strpos($href, $exc) !== false) return $matches[0];
        }

        // Already deferred?
        if (preg_match('/media\s*=\s*["\']print["\']/i', $attrs)) return $matches[0];

        // Convert to async loading with print/onload pattern
        $deferred = $matches[0];
        $deferred = preg_replace("/media\s*=\s*['\"]all['\"]/i", "media=\"print\" onload=\"this.media='all'\"", $deferred);
        // If no media attribute was present, add one
        if (!preg_match('/onload/i', $deferred)) {
            $deferred = str_replace('rel="stylesheet"', 'rel="stylesheet" media="print" onload="this.media=\'all\'"', $deferred);
            $deferred = str_replace("rel='stylesheet'", "rel='stylesheet' media='print' onload=\"this.media='all'\"", $deferred);
        }

        // Add noscript fallback
        $noscript = '<noscript>' . $matches[0] . '</noscript>';
        return $deferred . "\n" . $noscript;
    }, $html);

    return $html;
}

function sropt_generate_critical_css($html) {
    // 1. Extract all stylesheet URLs from HTML
    $stylesheet_urls = array();
    preg_match_all('/<link\b[^>]*rel\s*=\s*["\']stylesheet["\'][^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>/i', $html, $m1);
    if (!empty($m1[1])) $stylesheet_urls = array_merge($stylesheet_urls, $m1[1]);
    preg_match_all('/<link\b[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*rel\s*=\s*["\']stylesheet["\'][^>]*>/i', $html, $m2);
    if (!empty($m2[1])) $stylesheet_urls = array_merge($stylesheet_urls, $m2[1]);
    $stylesheet_urls = array_unique($stylesheet_urls);

    // 2. Read stylesheet files from disk
    $all_css = '';
    foreach ($stylesheet_urls as $url) {
        $path = sropt_url_to_local_path($url);
        if ($path && file_exists($path) && is_readable($path)) {
            $content = @file_get_contents($path);
            if ($content) {
                // Resolve relative URLs in CSS (url(../images/...) etc.)
                $css_dir_url = dirname($url);
                $content = preg_replace_callback('/url\s*\(\s*["\']?(?!data:|https?:|\/\/)([^"\')\s]+)["\']?\s*\)/i', function($m) use ($css_dir_url) {
                    $resolved = $css_dir_url . '/' . $m[1];
                    return 'url(' . $resolved . ')';
                }, $content);
                $all_css .= $content . "\n";
            }
        }
    }

    // 3. Also extract inline <style> blocks from the HTML
    preg_match_all('/<style\b[^>]*>(.*?)<\/style>/is', $html, $style_matches);
    if (!empty($style_matches[1])) {
        foreach ($style_matches[1] as $inline) {
            // Skip JSON-LD and template styles
            if (strpos($inline, 'application/ld+json') !== false) continue;
            $all_css .= $inline . "\n";
        }
    }

    if (empty(trim($all_css))) return '';

    // 4. Extract critical rules
    return sropt_extract_critical_rules($all_css);
}

function sropt_url_to_local_path($url) {
    // Remove query string
    $url = preg_replace('/\?.*$/', '', $url);

    // Handle protocol-relative URLs
    if (strpos($url, '//') === 0) $url = 'https:' . $url;

    $site_url = site_url();
    $abspath = rtrim(ABSPATH, '/');

    // Check if it's a local URL
    if (strpos($url, $site_url) === 0) {
        $relative = str_replace($site_url, '', $url);
        return $abspath . $relative;
    }

    // Try wp-content path
    if (preg_match('#/wp-content/(.+)#', $url, $m)) {
        return WP_CONTENT_DIR . '/' . $m[1];
    }

    // Try wp-includes path
    if (preg_match('#/wp-includes/(.+)#', $url, $m)) {
        return ABSPATH . 'wp-includes/' . $m[1];
    }

    return false;
}

function sropt_extract_critical_rules($all_css) {
    $critical = '';
    $max_size = 40960; // 40KB max — lean critical CSS for fast first paint

    // BLACKLIST approach: include rules EXCEPT known below-fold patterns
    $exclude_selectors = 'footer|\.footer|#footer|\.site-footer|\.widget-area|\.sidebar|#sidebar|\.comment|#comments|#respond|\.pagination|\.wp-pagenavi|\.post-navigation|\.screen-reader|\.sr-only|\.hidden|\.d-none|\.invisible|\.print-only|\.no-js|\.noprint|\.swiper-|\.slick-|\.owl-|\.carousel|\.modal|\.popup|\.lightbox|\.cookie|\.banner-close';

    // Always keep :root / CSS custom properties (small, essential)
    if (preg_match_all('/:root\s*\{[^}]+\}/i', $all_css, $roots)) {
        foreach ($roots[0] as $r) {
            $critical .= $r . "\n";
        }
    }

    // SMART @font-face: only keep fonts actually used in critical selectors
    // Extract font-family names used in the CSS body (not in @font-face itself)
    $css_no_fontface = preg_replace('/@font-face\s*\{[^}]+\}/i', '', $all_css);
    $used_fonts = array();
    if (preg_match_all('/font-family\s*:\s*([^;}{]+)/i', $css_no_fontface, $ff_uses)) {
        foreach ($ff_uses[1] as $ff_val) {
            // Extract first font in stack (the primary one)
            $fonts = explode(',', $ff_val);
            foreach ($fonts as $f) {
                $f = trim($f, " \t\n\r\"'");
                $f_lower = strtolower($f);
                // Skip generic families
                if (in_array($f_lower, array('serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset'))) continue;
                $used_fonts[$f_lower] = true;
            }
        }
    }

    // Now include only @font-face for fonts that are actually used, limit to woff2 format
    if (preg_match_all('/@font-face\s*\{[^}]+\}/i', $all_css, $font_faces)) {
        $font_count = 0;
        $max_fonts = 6; // Max 6 @font-face declarations (typically 2-3 families × 2 weights)
        foreach ($font_faces[0] as $ff) {
            if ($font_count >= $max_fonts) break;
            // Extract font-family from this @font-face
            if (preg_match('/font-family\s*:\s*["\']?([^"\';}]+)/i', $ff, $ffn)) {
                $face_name = strtolower(trim($ffn[1], " \t\n\r\"'"));
                // Only include if this font is actually referenced in styles
                if (isset($used_fonts[$face_name])) {
                    // Prefer woff2 only — strip other format src if woff2 exists
                    if (strpos($ff, 'woff2') !== false) {
                        $critical .= $ff . "\n";
                        $font_count++;
                    }
                }
            }
        }
    }

    // SKIP @keyframes entirely — animations are NOT critical for first paint
    // They load with the deferred stylesheets after critical CSS renders

    // Remove @font-face, @keyframes from CSS before parsing rules
    $css_no_at = preg_replace('/@font-face\s*\{[^}]+\}/i', '', $all_css);
    $css_no_at = preg_replace('/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/i', '', $css_no_at);

    // Extract @media blocks separately
    $media_blocks = array();
    $css_no_media = preg_replace_callback('/@media\s*([^{]+)\{((?:[^{}]*\{[^}]*\})*[^}]*)\}/i', function($m) use (&$media_blocks) {
        $media_blocks[] = array('query' => trim($m[1]), 'content' => $m[2]);
        return '';
    }, $css_no_at);

    // Parse individual CSS rules — INCLUDE ALL except blacklisted
    preg_match_all('/([^{}@]+)\{([^{}]+)\}/', $css_no_media, $rules, PREG_SET_ORDER);

    foreach ($rules as $rule) {
        if (strlen($critical) > $max_size) break;

        $selector = trim($rule[1]);
        $declarations = trim($rule[2]);

        if (preg_match('/^\d+%$|^from$|^to$/i', $selector)) continue;
        if (empty($declarations)) continue;

        // BLACKLIST: skip known below-fold and non-critical selectors
        if (preg_match('/(?:^|\s|,)(' . $exclude_selectors . ')\b/i', $selector)) continue;

        // Skip animation-only declarations (they reference keyframes we didn't include)
        if (preg_match('/^\s*animation\s*:/i', $declarations) && substr_count($declarations, ':') === 1) continue;

        $critical .= $selector . '{' . $declarations . "}\n";
    }

    // Process @media blocks — only include screen-relevant ones
    foreach ($media_blocks as $mb) {
        if (strlen($critical) > $max_size) break;

        // Skip print-only media queries
        if (preg_match('/\bprint\b/i', $mb['query']) && !preg_match('/\bscreen\b/i', $mb['query'])) continue;

        // Skip very large viewport media queries (likely tablet/desktop overrides on mobile-first)
        // Keep mobile and general responsive rules
        $inner_critical = '';
        preg_match_all('/([^{}@]+)\{([^{}]+)\}/', $mb['content'], $inner_rules, PREG_SET_ORDER);

        foreach ($inner_rules as $ir) {
            $sel = trim($ir[1]);
            $decl = trim($ir[2]);
            if (preg_match('/^\d+%$|^from$|^to$/i', $sel)) continue;
            if (empty($decl)) continue;
            if (preg_match('/(?:^|\s|,)(' . $exclude_selectors . ')\b/i', $sel)) continue;

            $inner_critical .= $sel . '{' . $decl . "}\n";
        }

        if (!empty($inner_critical)) {
            $critical .= '@media ' . $mb['query'] . '{' . $inner_critical . "}\n";
        }
    }

    return $critical;
}


// ================================================================
// JS OPTIMIZATION — DEFER/ASYNC
// ================================================================

add_filter('script_loader_tag', 'sropt_defer_js', 10, 3);
function sropt_defer_js($tag, $handle, $src) {
    if (is_admin()) return $tag;
    $options = sropt_get_options();
    if (!$options['enable_js_defer'] || $options['safe_mode']) return $tag;

    // jQuery will be delayed (not deferred) — skip defer for it so delay handler takes over
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
// JS DELAY — Don't execute JS until user interaction (scroll/click/touch)
// Biggest single TBT improvement. Used by WP Rocket, FlyingPress, etc.
// ================================================================

add_action('template_redirect', 'sropt_delay_js_start', 2);
function sropt_delay_js_start() {
    if (is_admin() || is_feed() || wp_doing_ajax()) return;
    if (defined('DOING_CRON') && DOING_CRON) return;
    if (is_user_logged_in()) return; // Don't delay for logged-in users (admin bars, etc.)

    $options = sropt_get_options();
    if (!$options['enable_js_delay'] || $options['safe_mode']) return;

    // Use output buffer to rewrite script tags
    ob_start('sropt_delay_js_rewrite');
}

function sropt_delay_js_rewrite($html) {
    if (empty($html) || strlen($html) < 200) return $html;
    if (stripos($html, '<html') === false && stripos($html, '<!DOCTYPE') === false) return $html;

    $options = sropt_get_options();
    $excludes = array_filter(array_map('trim', explode(',', $options['exclude_js'])));

    // Scripts that must NEVER be delayed (core functionality)
    // NOTE: jQuery IS delayed now — it loads first in the delay queue on user interaction
    // This is safe because all jQuery-dependent scripts are also delayed
    $never_delay = array(
        'wp-polyfill',
        'seoroom', // our own scripts
    );

    // Also never delay inline scripts that are critical for page rendering
    $never_delay_inline = array(
        'var wpApiSettings', 'var wc_', 'var elementorFrontendConfig',
        'window._wpemojiSettings', 'document.documentElement.className',
    );

    // Rewrite external scripts: change type to prevent execution
    $html = preg_replace_callback('/<script\b([^>]*)>(.*?)<\/script>/is', function($matches) use ($excludes, $never_delay, $never_delay_inline) {
        $attrs = $matches[1];
        $content = $matches[2];

        // Skip if already has our delay attribute
        if (strpos($attrs, 'data-seoroom-delay') !== false) return $matches[0];

        // Skip non-JS types (JSON-LD, templates, etc.)
        if (preg_match('/type\s*=\s*["\'](?!text\/javascript|application\/javascript|module)[^"\']*["\']/i', $attrs)) return $matches[0];

        // Check if it's an external script
        $is_external = preg_match('/\bsrc\s*=\s*["\']([^"\']+)["\']/i', $attrs, $src_match);
        $src = $is_external ? $src_match[1] : '';

        // Check never-delay list for external scripts
        if ($is_external) {
            foreach ($never_delay as $nd) {
                if (strpos($src, $nd) !== false) return $matches[0];
            }
            foreach ($excludes as $exc) {
                if (strpos($src, $exc) !== false) return $matches[0];
            }
        }

        // Check never-delay list for inline scripts
        if (!$is_external && !empty(trim($content))) {
            foreach ($never_delay_inline as $ndi) {
                if (strpos($content, $ndi) !== false) return $matches[0];
            }
            // Don't delay very short inline scripts (config/settings)
            if (strlen(trim($content)) < 100) return $matches[0];
        }

        // Skip scripts in <head> that set critical config (heuristic: before </head>)
        // We handle this via the never_delay_inline list above

        // Rewrite: change type to prevent execution, add data attribute
        if ($is_external) {
            // External: change type to text/seoroom-delay
            $new_attrs = preg_replace('/type\s*=\s*["\'][^"\']*["\']/i', '', $attrs);
            $new_attrs .= ' data-seoroom-delay="1" type="text/seoroom-delay"';
            return '<script' . $new_attrs . '>' . $content . '</script>';
        } else {
            // Inline: wrap in type=text/seoroom-delay
            $new_attrs = preg_replace('/type\s*=\s*["\'][^"\']*["\']/i', '', $attrs);
            $new_attrs .= ' data-seoroom-delay="1" type="text/seoroom-delay"';
            return '<script' . $new_attrs . '>' . $content . '</script>';
        }
    }, $html);

    // Inject the loader script right before </body>
    // jQuery loads first (priority sort), then all others sequentially
    $loader = '
<script id="seoroom-delay-loader">
(function(){
  var loaded=false;
  function loadAll(){
    if(loaded)return;loaded=true;
    var all=document.querySelectorAll("script[data-seoroom-delay]");
    // Sort: jQuery first, then jquery-migrate, then everything else
    var scripts=Array.prototype.slice.call(all);
    scripts.sort(function(a,b){
      var as=a.src||"",bs=b.src||"";
      var ap=as.indexOf("jquery.min")>-1||as.indexOf("jquery-core")>-1?0:as.indexOf("jquery-migrate")>-1?1:2;
      var bp=bs.indexOf("jquery.min")>-1||bs.indexOf("jquery-core")>-1?0:bs.indexOf("jquery-migrate")>-1?1:2;
      return ap-bp;
    });
    var i=0;
    function next(){
      if(i>=scripts.length)return;
      var s=scripts[i++];
      var n=document.createElement("script");
      if(s.src){n.src=s.src;n.onload=next;n.onerror=next;}
      else{n.textContent=s.textContent;setTimeout(next,0);}
      var attrs=s.attributes;
      for(var j=0;j<attrs.length;j++){
        var a=attrs[j].name;
        if(a!=="type"&&a!=="data-seoroom-delay")n.setAttribute(a,attrs[j].value);
      }
      s.parentNode.replaceChild(n,s);
      if(!s.src)next();
    }
    next();
  }
  var events=["mouseover","keydown","touchstart","touchmove","wheel","scroll","click"];
  events.forEach(function(e){window.addEventListener(e,loadAll,{once:true,passive:true});});
  // Fallback: load after 3 seconds (Lighthouse measures at ~3-5s mark)
  setTimeout(loadAll,3000);
})();
</script>';

    // Insert before </body>
    $body_close = strripos($html, '</body>');
    if ($body_close !== false) {
        $html = substr($html, 0, $body_close) . $loader . "\n" . substr($html, $body_close);
    }

    return $html;
}


// ================================================================
// CSS OPTIMIZATION — DEFER NON-CRITICAL (legacy, use Critical CSS instead)
// ================================================================

add_filter('style_loader_tag', 'sropt_optimize_css_tag', 10, 4);
function sropt_optimize_css_tag($tag, $handle, $href, $media) {
    if (is_admin()) return $tag;
    $options = sropt_get_options();
    if ($options['safe_mode']) return $tag;

    // If critical CSS is enabled, it handles deferral in the output buffer — skip here
    if ($options['enable_critical_css']) return $tag;

    // Legacy CSS defer (only active when critical CSS is off)
    if (!$options['enable_css_defer']) return $tag;

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
// PRELOAD LCP IMAGE — Auto-detect hero/banner image
// ================================================================

add_action('wp_head', 'sropt_preload_hints', 1);
function sropt_preload_hints() {
    if (is_admin()) return;
    $options = sropt_get_options();
    if (!$options['enable_lcp_preload']) return;

    $preload_url = '';

    if (is_singular()) {
        // 1. Try post thumbnail (featured image) — most common LCP candidate
        if (has_post_thumbnail()) {
            $thumb_id = get_post_thumbnail_id();
            $thumb_url = wp_get_attachment_image_url($thumb_id, 'large');
            if ($thumb_url) $preload_url = $thumb_url;
        }

        // 2. If no thumbnail, try first image in content
        if (!$preload_url) {
            $post = get_post();
            if ($post && !empty($post->post_content)) {
                if (preg_match('/<img\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\'][^>]*>/i', $post->post_content, $img_match)) {
                    $preload_url = $img_match[1];
                }
            }
        }
    }

    // 3. Try custom logo (works for homepage and archive pages)
    if (!$preload_url && function_exists('get_custom_logo')) {
        $custom_logo_id = get_theme_mod('custom_logo');
        if ($custom_logo_id) {
            $logo_url = wp_get_attachment_image_url($custom_logo_id, 'full');
            if ($logo_url) $preload_url = $logo_url;
        }
    }

    if ($preload_url) {
        // Determine image type for better preload hint
        $type = '';
        if (preg_match('/\.webp(\?|$)/i', $preload_url)) $type = ' type="image/webp"';
        elseif (preg_match('/\.png(\?|$)/i', $preload_url)) $type = ' type="image/png"';
        elseif (preg_match('/\.svg(\?|$)/i', $preload_url)) $type = ' type="image/svg+xml"';

        echo '<link rel="preload" as="image" href="' . esc_url($preload_url) . '"' . $type . ' fetchpriority="high">' . "\n";
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
        'meta'  => array('title' => 'SEO Room v' . SEOROOM_VERSION . ' — Speed + Schema + Critical CSS'),
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
    if (!empty($_GET)) return;

    $options = sropt_get_options();
    if (!$options['enable_page_cache'] || $options['safe_mode']) return;

    $request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $excludes = array_filter(array_map('trim', explode(',', $options['cache_exclude_urls'])));
    foreach ($excludes as $exc) {
        if (strpos($request_uri, $exc) !== false) return;
    }

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
            @unlink($cache_file);
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

    $headers = headers_list();
    foreach ($headers as $h) {
        if (stripos($h, 'X-SEORoom-Cache: HIT') !== false) return;
    }

    $request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $excludes = array_filter(array_map('trim', explode(',', $options['cache_exclude_urls'])));
    foreach ($excludes as $exc) {
        if (strpos($request_uri, $exc) !== false) return;
    }
    $never_cache = array('/wp-admin', '/wp-login', '/cart', '/checkout', '/my-account', '/wp-json', '/feed');
    foreach ($never_cache as $nc) {
        if (strpos($request_uri, $nc) !== false) return;
    }

    $status = http_response_code();
    if ($status && $status !== 200) return;

    $cache_file = sropt_page_cache_path();
    if (!$cache_file) return;

    $content = '';
    $levels = ob_get_level();
    if ($levels > 0) {
        $content = ob_get_contents();
    }

    if (empty($content) || strlen($content) < 200) return;
    if (stripos($content, '<html') === false) return;

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
        $url = get_permalink($post_id);
        if ($url) {
            $uri = parse_url($url, PHP_URL_PATH);
            $host = parse_url(home_url(), PHP_URL_HOST);
            $key = md5($host . $uri);
            $file = $dir . $key . '.html';
            if (file_exists($file)) @unlink($file);
        }
        $home_key = md5(parse_url(home_url(), PHP_URL_HOST) . '/');
        $home_file = $dir . $home_key . '.html';
        if (file_exists($home_file)) @unlink($home_file);
    } else {
        $files = glob($dir . '*.html');
        if ($files) array_map('unlink', $files);
    }

    // Also clear critical CSS cache on content update
    $critical_dir = WP_CONTENT_DIR . '/cache/seoroom/critical/';
    if (file_exists($critical_dir)) {
        $files = glob($critical_dir . '*.css');
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

    if (!sropt_can_create_webp()) return $content;

    $content = preg_replace_callback('/<img\b([^>]*)\bsrc\s*=\s*["\']([^"\']+)["\']([^>]*)>/i', function($matches) use ($options) {
        $before = $matches[1];
        $src = $matches[2];
        $after = $matches[3];

        if (!preg_match('/\.(jpe?g|png)(\?.*)?$/i', $src)) return $matches[0];
        $upload_dir = wp_upload_dir();
        $upload_url = $upload_dir['baseurl'];
        if (strpos($src, $upload_url) === false && strpos($src, '/wp-content/uploads/') === false) return $matches[0];

        $webp_url = sropt_get_webp_url($src, (int)$options['webp_quality']);
        if (!$webp_url) return $matches[0];

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
        $picture .= $matches[0];
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

    $relative = preg_replace('/\?.*$/', '', $relative);
    $src_path = $upload_path . $relative;
    if (!file_exists($src_path)) return false;

    $webp_relative = preg_replace('/\.(jpe?g|png)$/i', '.webp', $relative);
    $webp_dir = WP_CONTENT_DIR . '/cache/seoroom/webp';
    $webp_path = $webp_dir . $webp_relative;

    if (file_exists($webp_path) && filemtime($webp_path) >= filemtime($src_path)) {
        return content_url('/cache/seoroom/webp' . $webp_relative);
    }

    $webp_subdir = dirname($webp_path);
    if (!file_exists($webp_subdir)) wp_mkdir_p($webp_subdir);

    $ext = strtolower(pathinfo($src_path, PATHINFO_EXTENSION));
    $created = false;

    if (function_exists('imagewebp')) {
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
            $critical_count = count(glob(WP_CONTENT_DIR . '/cache/seoroom/critical/*.css') ?: array());
            return new WP_REST_Response(array(
                'active'     => true,
                'version'    => SEOROOM_VERSION,
                'safe_mode'  => $is_safe,
                'project_id' => $options['project_id'] ?: null,
                'features'  => array(
                    'schema'          => $options['enable_schema'],
                    'lazy_load'       => $options['enable_lazy_load'],
                    'image_dims'      => $options['enable_image_dims'],
                    'image_compress'  => $options['enable_image_compress'],
                    'critical_css'    => $options['enable_critical_css'] && !$is_safe,
                    'css_minify'      => $options['enable_css_minify'] && !$is_safe,
                    'css_defer'       => ($options['enable_critical_css'] || $options['enable_css_defer']) && !$is_safe,
                    'js_defer'        => $options['enable_js_defer'] && !$is_safe,
                    'js_delay'        => $options['enable_js_delay'] && !$is_safe,
                    'js_minify'       => $options['enable_js_minify'] && !$is_safe,
                    'gzip'            => $options['enable_gzip'],
                    'cache_headers'   => $options['enable_cache_headers'],
                    'font_swap'       => $options['enable_font_swap'],
                    'preconnect'      => $options['enable_preconnect'],
                    'dns_prefetch'    => $options['enable_dns_prefetch'],
                    'lcp_preload'     => $options['enable_lcp_preload'],
                    'page_cache'      => $options['enable_page_cache'] && !$is_safe,
                    'webp'            => $options['enable_webp'],
                    '404_monitor'     => $options['enable_404_monitor'],
                    'redirects'       => $options['enable_redirects'],
                    'link_checker'    => true,
                ),
                'cache_stats' => array(
                    'critical_css_pages' => $critical_count,
                ),
            ), 200);
        },
        'permission_callback' => '__return_true',
    ));

    // ---- 404 Monitor REST Endpoints ----
    register_rest_route('seoroom-opt/v1', '/404s', array(
        'methods'  => 'GET',
        'callback' => function($request) {
            global $wpdb;
            $table = $wpdb->prefix . 'seoroom_404s';
            $limit = intval($request->get_param('limit') ?: 100);
            $offset = intval($request->get_param('offset') ?: 0);
            $rows = $wpdb->get_results($wpdb->prepare(
                "SELECT * FROM $table ORDER BY hit_count DESC, last_seen DESC LIMIT %d OFFSET %d", $limit, $offset
            ));
            $total = $wpdb->get_var("SELECT COUNT(*) FROM $table");
            return new WP_REST_Response(array('items' => $rows, 'total' => intval($total)), 200);
        },
        'permission_callback' => '__return_true',
    ));

    register_rest_route('seoroom-opt/v1', '/404s/(?P<id>\d+)', array(
        'methods'  => 'DELETE',
        'callback' => function($request) {
            global $wpdb;
            $wpdb->delete($wpdb->prefix . 'seoroom_404s', array('id' => $request['id']));
            return new WP_REST_Response(array('ok' => true), 200);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    register_rest_route('seoroom-opt/v1', '/404s/clear', array(
        'methods'  => 'POST',
        'callback' => function() {
            global $wpdb;
            $wpdb->query("TRUNCATE TABLE {$wpdb->prefix}seoroom_404s");
            return new WP_REST_Response(array('ok' => true), 200);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    // ---- Redirects REST Endpoints ----
    register_rest_route('seoroom-opt/v1', '/redirects', array(
        'methods'  => 'GET',
        'callback' => function($request) {
            global $wpdb;
            $table = $wpdb->prefix . 'seoroom_redirects';
            $limit = intval($request->get_param('limit') ?: 100);
            $offset = intval($request->get_param('offset') ?: 0);
            $rows = $wpdb->get_results($wpdb->prepare(
                "SELECT * FROM $table ORDER BY updated_at DESC LIMIT %d OFFSET %d", $limit, $offset
            ));
            $total = $wpdb->get_var("SELECT COUNT(*) FROM $table");
            return new WP_REST_Response(array('items' => $rows, 'total' => intval($total)), 200);
        },
        'permission_callback' => '__return_true',
    ));

    register_rest_route('seoroom-opt/v1', '/redirects', array(
        'methods'  => 'POST',
        'callback' => function($request) {
            global $wpdb;
            $table = $wpdb->prefix . 'seoroom_redirects';
            $source = trim($request->get_param('source_url'));
            $target = trim($request->get_param('target_url'));
            $type = intval($request->get_param('redirect_type') ?: 301);
            if (empty($source) || empty($target)) {
                return new WP_REST_Response(array('error' => 'source_url and target_url required'), 400);
            }
            // Normalize source to path only
            $parsed = parse_url($source);
            $source_path = $parsed['path'] ?? $source;
            $hash = md5($source_path);
            $wpdb->query($wpdb->prepare(
                "INSERT INTO $table (source_url, source_hash, target_url, redirect_type) VALUES (%s, %s, %s, %d)
                 ON DUPLICATE KEY UPDATE target_url=%s, redirect_type=%d, updated_at=NOW()",
                $source_path, $hash, $target, $type, $target, $type
            ));
            $id = $wpdb->insert_id ?: $wpdb->get_var($wpdb->prepare("SELECT id FROM $table WHERE source_hash=%s", $hash));
            $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id=%d", $id));
            return new WP_REST_Response(array('redirect' => $row), 201);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    register_rest_route('seoroom-opt/v1', '/redirects/(?P<id>\d+)', array(
        'methods'  => 'PUT',
        'callback' => function($request) {
            global $wpdb;
            $table = $wpdb->prefix . 'seoroom_redirects';
            $updates = array();
            $formats = array();
            if ($request->get_param('target_url') !== null) { $updates['target_url'] = $request->get_param('target_url'); $formats[] = '%s'; }
            if ($request->get_param('redirect_type') !== null) { $updates['redirect_type'] = intval($request->get_param('redirect_type')); $formats[] = '%d'; }
            if (!empty($updates)) {
                $updates['updated_at'] = current_time('mysql');
                $formats[] = '%s';
                $wpdb->update($table, $updates, array('id' => $request['id']), $formats, array('%d'));
            }
            $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id=%d", $request['id']));
            return new WP_REST_Response(array('redirect' => $row), 200);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    register_rest_route('seoroom-opt/v1', '/redirects/(?P<id>\d+)', array(
        'methods'  => 'DELETE',
        'callback' => function($request) {
            global $wpdb;
            $wpdb->delete($wpdb->prefix . 'seoroom_redirects', array('id' => $request['id']));
            return new WP_REST_Response(array('ok' => true), 200);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    // ---- Create redirect from 404 (convenience) ----
    register_rest_route('seoroom-opt/v1', '/404s/(?P<id>\d+)/redirect', array(
        'methods'  => 'POST',
        'callback' => function($request) {
            global $wpdb;
            $t404 = $wpdb->prefix . 'seoroom_404s';
            $tred = $wpdb->prefix . 'seoroom_redirects';
            $row404 = $wpdb->get_row($wpdb->prepare("SELECT * FROM $t404 WHERE id=%d", $request['id']));
            if (!$row404) return new WP_REST_Response(array('error' => '404 not found'), 404);
            $target = trim($request->get_param('target_url') ?: '/');
            $type = intval($request->get_param('redirect_type') ?: 301);
            $hash = md5($row404->url);
            $wpdb->query($wpdb->prepare(
                "INSERT INTO $tred (source_url, source_hash, target_url, redirect_type) VALUES (%s, %s, %s, %d)
                 ON DUPLICATE KEY UPDATE target_url=%s, redirect_type=%d, updated_at=NOW()",
                $row404->url, $hash, $target, $type, $target, $type
            ));
            // Remove from 404 log
            $wpdb->delete($t404, array('id' => $request['id']));
            return new WP_REST_Response(array('ok' => true), 201);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    // ---- Internal Link Checker REST Endpoints ----
    register_rest_route('seoroom-opt/v1', '/link-check', array(
        'methods'  => 'POST',
        'callback' => 'sropt_run_link_check',
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    register_rest_route('seoroom-opt/v1', '/broken-links', array(
        'methods'  => 'GET',
        'callback' => function($request) {
            global $wpdb;
            $table = $wpdb->prefix . 'seoroom_broken_links';
            $limit = intval($request->get_param('limit') ?: 100);
            $rows = $wpdb->get_results($wpdb->prepare(
                "SELECT * FROM $table ORDER BY status_code ASC, scanned_at DESC LIMIT %d", $limit
            ));
            $total = $wpdb->get_var("SELECT COUNT(*) FROM $table");
            return new WP_REST_Response(array('items' => $rows, 'total' => intval($total)), 200);
        },
        'permission_callback' => '__return_true',
    ));

    register_rest_route('seoroom-opt/v1', '/broken-links/clear', array(
        'methods'  => 'POST',
        'callback' => function() {
            global $wpdb;
            $wpdb->query("TRUNCATE TABLE {$wpdb->prefix}seoroom_broken_links");
            return new WP_REST_Response(array('ok' => true), 200);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));

    // ---- Page Audit — Internal crawl (bypasses Cloudflare) ----
    register_rest_route('seoroom-opt/v1', '/page-audit', array(
        'methods'  => 'GET',
        'callback' => 'sropt_page_audit',
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));
});

/**
 * Page Audit endpoint — crawls all published pages/posts from inside WordPress.
 * Returns structured data matching what the dashboard website audit expects.
 * No Cloudflare issues since it reads directly from DB + renders internally.
 */
function sropt_page_audit() {
    $start = microtime(true);
    $pages = array();
    $site_url = trailingslashit(get_site_url());
    $domain = parse_url($site_url, PHP_URL_HOST);

    // Get all published pages and posts
    $args = array(
        'post_type'      => array('page', 'post'),
        'post_status'    => 'publish',
        'posts_per_page' => 200,
        'orderby'        => 'menu_order title',
        'order'          => 'ASC',
    );
    $query = new WP_Query($args);

    foreach ($query->posts as $post) {
        $url = get_permalink($post);
        $path = str_replace($site_url, '/', $url);
        $path = '/' . ltrim($path, '/');

        // Get Yoast meta if available
        $meta_title = '';
        $meta_desc  = '';
        if (class_exists('WPSEO_Meta')) {
            $meta_title = WPSEO_Meta::get_value('title', $post->ID) ?: '';
            $meta_desc  = WPSEO_Meta::get_value('metadesc', $post->ID) ?: '';
        }
        if (!$meta_title) $meta_title = get_post_meta($post->ID, '_yoast_wpseo_title', true) ?: $post->post_title;
        if (!$meta_desc)  $meta_desc  = get_post_meta($post->ID, '_yoast_wpseo_metadesc', true) ?: '';

        // Render content to get accurate word count (includes shortcodes, blocks, etc.)
        $content = apply_filters('the_content', $post->post_content);
        $text = wp_strip_all_tags($content);
        $word_count = str_word_count($text);

        // H1/H2 from rendered content
        $h1s = array();
        $h2s = array();
        if (preg_match_all('/<h1[^>]*>(.*?)<\/h1>/is', $content, $m)) {
            $h1s = array_map('wp_strip_all_tags', $m[1]);
        }
        if (preg_match_all('/<h2[^>]*>(.*?)<\/h2>/is', $content, $m)) {
            $h2s = array_map('wp_strip_all_tags', $m[1]);
        }

        // Images
        $images_total = 0;
        $images_missing_alt = 0;
        $missing_alt_srcs = array();
        if (preg_match_all('/<img[^>]*>/i', $content, $img_matches)) {
            $images_total = count($img_matches[0]);
            foreach ($img_matches[0] as $img_tag) {
                $has_alt = preg_match('/alt=["\']([^"\']+)["\']/i', $img_tag, $am);
                if (!$has_alt || trim($am[1]) === '') {
                    $images_missing_alt++;
                    if (preg_match('/src=["\']([^"\']+)["\']/i', $img_tag, $sm)) {
                        $missing_alt_srcs[] = $sm[1];
                    }
                }
            }
        }

        // Schema from SEO Room plugin
        $seoroom_schema = get_post_meta($post->ID, '_seoroom_schema', true);
        $schemas = array();
        $schema_sources = array();
        if ($seoroom_schema) {
            $parsed = json_decode($seoroom_schema, true);
            if ($parsed && isset($parsed['@type'])) {
                $types = (array)$parsed['@type'];
                foreach ($types as $t) {
                    $schemas[] = $t;
                    $schema_sources[] = array('type' => $t, 'source' => 'seoroom');
                }
            }
        }

        // Check Yoast schema too
        $yoast_json = get_post_meta($post->ID, '_yoast_wpseo_schema_page_type', true);
        if ($yoast_json) {
            $schemas[] = $yoast_json;
            $schema_sources[] = array('type' => $yoast_json, 'source' => 'yoast');
        }

        // Canonical
        $canonical = '';
        if (class_exists('WPSEO_Meta')) {
            $canonical = WPSEO_Meta::get_value('canonical', $post->ID) ?: '';
        }
        if (!$canonical) $canonical = $url; // self-referencing

        // Noindex
        $noindex_val = get_post_meta($post->ID, '_yoast_wpseo_meta-robots-noindex', true);
        $is_noindex = ($noindex_val === '1');

        // Robots meta
        $robots_meta = $is_noindex ? 'noindex' : '';

        // Internal/external links
        $internal_links = 0;
        $external_links = 0;
        if (preg_match_all('/href=["\']([^"\'#]+)["\']/i', $content, $link_matches)) {
            foreach ($link_matches[1] as $href) {
                if (strpos($href, 'mailto:') === 0 || strpos($href, 'tel:') === 0) continue;
                if (strpos($href, $domain) !== false || strpos($href, '/') === 0) {
                    $internal_links++;
                } elseif (strpos($href, 'http') === 0) {
                    $external_links++;
                }
            }
        }

        // OG tags (check if Yoast generates them — it does by default)
        $has_og = class_exists('WPSEO_Options');

        // FAQ detection
        $question_headings = 0;
        if (preg_match_all('/<h[2-4][^>]*>[^<]*\?[^<]*<\/h[2-4]>/i', $content, $qm)) {
            $question_headings = count($qm[0]);
        }
        $has_faq = (bool)preg_match('/<h[1-4][^>]*>[^<]*(faq|frequently asked|common questions)[^<]*<\/h[1-4]>/i', $content);

        $pages[] = array(
            'url'              => $url,
            'path'             => $path,
            'title'            => $post->post_title,
            'statusCode'       => 200,
            'elapsed'          => 0, // internal read, no HTTP latency
            'metaTitle'        => $meta_title,
            'metaTitleLength'  => strlen($meta_title),
            'metaDesc'         => $meta_desc,
            'metaDescLength'   => strlen($meta_desc),
            'h1s'              => $h1s,
            'h2s'              => $h2s,
            'wordCount'        => $word_count,
            'images'           => $images_total,
            'imagesWithoutAlt' => $images_missing_alt,
            'imagesMissingAlt' => $missing_alt_srcs,
            'internalLinks'    => $internal_links,
            'externalLinks'    => $external_links,
            'schemas'          => $schemas,
            'schemaSources'    => $schema_sources,
            'canonical'        => $canonical,
            'hasViewport'      => true, // WordPress themes always have viewport
            'robotsMeta'       => $robots_meta,
            'isNoindex'        => $is_noindex,
            'isHttps'          => (strpos($site_url, 'https') === 0),
            'hasOG'            => $has_og,
            'questionHeadings' => $question_headings,
            'hasFAQSection'    => $has_faq,
            'wasRedirected'    => false,
        );
    }

    $elapsed = round((microtime(true) - $start) * 1000);
    return new WP_REST_Response(array(
        'success' => true,
        'pages'   => $pages,
        'total'   => count($pages),
        'elapsed_ms' => $elapsed,
    ), 200);
}


// ================================================================
// PUSH TO DASHBOARD — Sends page audit data to SEO Room Dashboard
// Outbound from WP → Railway (bypasses Cloudflare)
// ================================================================

/**
 * Push page audit data to the dashboard connector-push endpoint.
 * Called by WP-Cron (daily) and manually from settings page.
 */
function sropt_push_to_dashboard() {
    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'] ?? '', '/');
    $project_id    = $options['project_id'] ?? '';
    $token         = $options['connection_code'] ?? '';

    if (!$dashboard_url || !$project_id || !$token) {
        return new WP_Error('config', 'Dashboard URL, Project ID, and Connection Code are required.');
    }

    // Collect page audit data using the same function as the REST endpoint
    $audit_response = sropt_page_audit();
    $audit_data = $audit_response->get_data();

    if (empty($audit_data['pages'])) {
        return new WP_Error('no_pages', 'No pages found to push.');
    }

    // Push to dashboard
    $push_url = $dashboard_url . '/api/connector-push/' . $project_id;
    $response = wp_remote_post($push_url, array(
        'timeout'  => 60,
        'headers'  => array(
            'Content-Type'  => 'application/json',
            'Authorization' => 'Bearer ' . $token,
        ),
        'body' => wp_json_encode(array(
            'success' => true,
            'pages'   => $audit_data['pages'],
        )),
    ));

    if (is_wp_error($response)) {
        update_option('sropt_last_push', array(
            'status' => 'error',
            'error'  => $response->get_error_message(),
            'time'   => current_time('mysql'),
        ));
        return $response;
    }

    $code = wp_remote_retrieve_response_code($response);
    $body = json_decode(wp_remote_retrieve_body($response), true);

    $result = array(
        'status'     => ($code === 200 && !empty($body['success'])) ? 'ok' : 'error',
        'http_code'  => $code,
        'pages'      => count($audit_data['pages']),
        'time'       => current_time('mysql'),
    );
    if ($result['status'] === 'error') {
        $result['error'] = $body['error'] ?? "HTTP $code";
    }

    update_option('sropt_last_push', $result);
    return $result;
}

// REST endpoint for manual push from settings page
add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/push-now', array(
        'methods'  => 'POST',
        'callback' => function() {
            $result = sropt_push_to_dashboard();
            if (is_wp_error($result)) {
                return new WP_REST_Response(array('ok' => false, 'error' => $result->get_error_message()), 500);
            }
            return new WP_REST_Response(array('ok' => true, 'result' => $result), 200);
        },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));
});

// WP-Cron: schedule daily push
add_action('sropt_daily_push', 'sropt_push_to_dashboard');
register_activation_hook(__FILE__, function() {
    if (!wp_next_scheduled('sropt_daily_push')) {
        wp_schedule_event(time(), 'daily', 'sropt_daily_push');
    }
});
register_deactivation_hook(__FILE__, function() {
    wp_clear_scheduled_hook('sropt_daily_push');
});
// Ensure cron is scheduled (in case plugin was already active)
add_action('init', function() {
    if (!wp_next_scheduled('sropt_daily_push')) {
        wp_schedule_event(time(), 'daily', 'sropt_daily_push');
    }
});

// Also push on plugin activation after tables are created
add_action('admin_init', function() {
    $options = sropt_get_options();
    $last_push = get_option('sropt_last_push');
    // Auto-push on first activation if connected
    if ($options['project_id'] && $options['connection_code'] && !$last_push) {
        sropt_push_to_dashboard();
    }
});


// ================================================================
// REDIRECT MANAGER — Fires before WordPress loads anything
// ================================================================

add_action('template_redirect', 'sropt_check_redirects', -1);
function sropt_check_redirects() {
    $options = sropt_get_options();
    if (!$options['enable_redirects']) return;

    global $wpdb;
    $table = $wpdb->prefix . 'seoroom_redirects';

    // Check if table exists (avoid errors before activation)
    if ($wpdb->get_var("SHOW TABLES LIKE '$table'") !== $table) return;

    $request_path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $hash = md5($request_path);

    $redirect = $wpdb->get_row($wpdb->prepare(
        "SELECT * FROM $table WHERE source_hash = %s LIMIT 1", $hash
    ));

    if ($redirect) {
        // Increment hit count
        $wpdb->query($wpdb->prepare(
            "UPDATE $table SET hit_count = hit_count + 1 WHERE id = %d", $redirect->id
        ));
        wp_redirect($redirect->target_url, intval($redirect->redirect_type));
        exit;
    }
}


// ================================================================
// 404 MONITOR — Log every 404 hit
// ================================================================

add_action('template_redirect', 'sropt_monitor_404', 99);
function sropt_monitor_404() {
    if (!is_404()) return;

    $options = sropt_get_options();
    if (!$options['enable_404_monitor']) return;

    global $wpdb;
    $table = $wpdb->prefix . 'seoroom_404s';

    // Check if table exists
    if ($wpdb->get_var("SHOW TABLES LIKE '$table'") !== $table) return;

    $url = $_SERVER['REQUEST_URI'];
    $hash = md5($url);
    $referrer = $_SERVER['HTTP_REFERER'] ?? '';
    $ua = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 512);

    // Upsert: increment hit_count if URL already logged
    $wpdb->query($wpdb->prepare(
        "INSERT INTO $table (url, url_hash, referrer, user_agent, hit_count, first_seen, last_seen)
         VALUES (%s, %s, %s, %s, 1, NOW(), NOW())
         ON DUPLICATE KEY UPDATE hit_count = hit_count + 1, last_seen = NOW(), referrer = IF(%s != '', %s, referrer)",
        $url, $hash, $referrer, $ua, $referrer, $referrer
    ));
}


// ================================================================
// INTERNAL LINK CHECKER — Scan pages for broken internal links
// ================================================================

function sropt_run_link_check($request) {
    global $wpdb;
    $table = $wpdb->prefix . 'seoroom_broken_links';

    // Clear previous results
    $wpdb->query("TRUNCATE TABLE $table");

    $site_url = home_url();
    $site_host = parse_url($site_url, PHP_URL_HOST);

    // Get all published pages and posts
    $posts = $wpdb->get_results(
        "SELECT ID, post_title, post_content, guid FROM {$wpdb->posts}
         WHERE post_status = 'publish' AND post_type IN ('page', 'post')
         ORDER BY ID ASC LIMIT 200"
    );

    $checked_urls = array(); // Cache: url => status_code
    $broken = 0;
    $total_links = 0;
    $max_checks = intval($request->get_param('max_checks') ?: 500);

    foreach ($posts as $post) {
        $content = $post->post_content;
        if (empty($content)) continue;

        // Extract all links from content
        preg_match_all('/<a\b[^>]*href\s*=\s*["\']([^"\'#]+)["\'][^>]*>(.*?)<\/a>/is', $content, $matches, PREG_SET_ORDER);

        foreach ($matches as $match) {
            if ($total_links >= $max_checks) break 2;

            $href = $match[1];
            $anchor = wp_strip_all_tags($match[2]);

            // Normalize URL
            if (strpos($href, '//') === 0) $href = 'https:' . $href;
            if (strpos($href, '/') === 0) $href = $site_url . $href;

            // Determine link type
            $link_host = parse_url($href, PHP_URL_HOST);
            $is_internal = ($link_host === $site_host || empty($link_host));
            $link_type = $is_internal ? 'internal' : 'external';

            // Only check internal links by default (external is slow)
            $check_external = $request->get_param('check_external');
            if (!$is_internal && !$check_external) continue;

            // Skip mailto, tel, javascript
            if (preg_match('/^(mailto:|tel:|javascript:)/i', $href)) continue;

            $total_links++;

            // Check cache first
            if (isset($checked_urls[$href])) {
                $status = $checked_urls[$href];
            } else {
                $status = sropt_check_url_status($href);
                $checked_urls[$href] = $status;
            }

            // Log broken links (non-200 status)
            if ($status >= 400 || $status === 0) {
                $broken++;
                $page_url = get_permalink($post->ID) ?: $post->guid;
                $wpdb->insert($table, array(
                    'source_url'     => $page_url,
                    'source_post_id' => $post->ID,
                    'target_url'     => $href,
                    'status_code'    => $status,
                    'anchor_text'    => substr($anchor, 0, 512),
                    'link_type'      => $link_type,
                    'scanned_at'     => current_time('mysql'),
                ));
            }
        }
    }

    return new WP_REST_Response(array(
        'ok'           => true,
        'pages_scanned' => count($posts),
        'links_checked' => $total_links,
        'broken_found'  => $broken,
    ), 200);
}

function sropt_check_url_status($url) {
    $args = array(
        'timeout'     => 10,
        'redirection' => 5,
        'sslverify'   => false,
        'method'      => 'HEAD', // Fast — don't download body
        'user-agent'  => 'SEORoom Link Checker/1.0',
    );

    $response = wp_remote_head($url, $args);

    if (is_wp_error($response)) {
        // HEAD might be blocked, try GET
        $response = wp_remote_get($url, array_merge($args, array('method' => 'GET')));
        if (is_wp_error($response)) return 0;
    }

    return wp_remote_retrieve_response_code($response);
}
