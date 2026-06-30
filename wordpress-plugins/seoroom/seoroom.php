<?php
/**
 * Plugin Name: SEO Room
 * Plugin URI: https://theseoroom.com.au
 * Description: SEO tools + complementary speed optimizations. Works alongside BerqWP/cloud cache. Features: JSON-LD schema, 404 monitor, redirects, broken link checker, CLS prevention (image dims), font-display swap, preconnect/prefetch, LCP preload, jQuery delay, unused CSS removal. Dashboard connector for SEO Room v5.
 * Version: 8.9.36
 * Author: The SEO Room
 * Author URI: https://theseoroom.com.au
 * License: GPL v2 or later
 * Text Domain: seoroom
 */

if (!defined('ABSPATH')) exit;

define('SEOROOM_VERSION', '8.9.34');
define('SEOROOM_PATH', plugin_dir_path(__FILE__));
define('SEOROOM_URL', plugin_dir_url(__FILE__));
define('SEOROOM_UPDATE_BASE', 'https://seo-room-v5-production.up.railway.app/plugin/seoroom');

// ============ AUTO-UPDATE FROM THE SEO ROOM DASHBOARD ============
// Change the plugin once on the dashboard → every client site sees the update (and auto-updates if enabled).
// No per-site reinstall. Pulls version info + zip from the dashboard.
add_filter('pre_set_site_transient_update_plugins', 'seoroom_check_for_update');
function seoroom_check_for_update($transient) {
    if (empty($transient) || empty($transient->checked)) return $transient;
    $info = seoroom_fetch_update_info();
    if (!$info || empty($info->version)) return $transient;
    $plugin_file = plugin_basename(__FILE__); // seoroom/seoroom.php
    if (version_compare($info->version, SEOROOM_VERSION, '>')) {
        $transient->response[$plugin_file] = (object) array(
            'slug'        => 'seoroom',
            'plugin'      => $plugin_file,
            'new_version' => $info->version,
            'url'         => isset($info->homepage) ? $info->homepage : 'https://theseoroom.com.au',
            'package'     => $info->download_url,
            'tested'      => isset($info->tested) ? $info->tested : '',
        );
    } else {
        // Ensure WP knows it's current (prevents stale "update available" flicker).
        unset($transient->response[$plugin_file]);
        $transient->no_update[$plugin_file] = (object) array(
            'slug' => 'seoroom', 'plugin' => $plugin_file, 'new_version' => SEOROOM_VERSION,
            'url' => 'https://theseoroom.com.au', 'package' => '',
        );
    }
    return $transient;
}
add_filter('plugins_api', 'seoroom_plugin_info', 20, 3);
function seoroom_plugin_info($result, $action, $args) {
    if ($action !== 'plugin_information') return $result;
    if (empty($args->slug) || $args->slug !== 'seoroom') return $result;
    $info = seoroom_fetch_update_info();
    if (!$info) return $result;
    return (object) array(
        'name'          => 'SEO Room',
        'slug'          => 'seoroom',
        'version'       => $info->version,
        'author'        => 'The SEO Room',
        'homepage'      => isset($info->homepage) ? $info->homepage : 'https://theseoroom.com.au',
        'download_link' => $info->download_url,
        'sections'      => array('changelog' => isset($info->changelog) ? $info->changelog : 'Latest SEO Room dashboard sync.'),
    );
}
function seoroom_fetch_update_info() {
    $cached = get_transient('seoroom_update_info');
    if ($cached !== false) return $cached;
    $resp = wp_remote_get(SEOROOM_UPDATE_BASE . '/info', array('timeout' => 10, 'headers' => array('Accept' => 'application/json')));
    if (is_wp_error($resp) || wp_remote_retrieve_response_code($resp) !== 200) { set_transient('seoroom_update_info', null, 6 * HOUR_IN_SECONDS); return null; }
    $body = json_decode(wp_remote_retrieve_body($resp));
    set_transient('seoroom_update_info', $body ?: null, 6 * HOUR_IN_SECONDS);
    return $body ?: null;
}
// After updating, clear the cached info + WP update cache so the new version registers immediately.
add_action('upgrader_process_complete', function($upgrader, $hook_extra) {
    if (isset($hook_extra['type']) && $hook_extra['type'] === 'plugin') { delete_transient('seoroom_update_info'); }
}, 10, 2);

// ============ SECURITY HEADERS ============
// Output security response headers based on saved options (set from the dashboard Security Audit).
// Design-safe: headers never alter page appearance. Fully reversible — clear the option to remove.
add_action('send_headers', 'seoroom_send_security_headers');
function seoroom_send_security_headers() {
    if (is_admin()) return; // never touch wp-admin
    $h = get_option('seoroom_security_headers', array());
    if (empty($h) || !is_array($h)) return;
    if (!empty($h['x_frame_options']))        header('X-Frame-Options: ' . $h['x_frame_options']);
    if (!empty($h['x_content_type_options'])) header('X-Content-Type-Options: ' . $h['x_content_type_options']);
    if (!empty($h['referrer_policy']))        header('Referrer-Policy: ' . $h['referrer_policy']);
    if (!empty($h['permissions_policy']))     header('Permissions-Policy: ' . $h['permissions_policy']);
    // HSTS only over HTTPS (sending it over HTTP is ignored anyway, but be correct)
    if (!empty($h['strict_transport_security']) && is_ssl()) header('Strict-Transport-Security: ' . $h['strict_transport_security']);
    // CSP report-only by default so it never breaks the live site
    if (!empty($h['csp_report_only']))        header('Content-Security-Policy-Report-Only: ' . $h['csp_report_only']);
    if (!empty($h['csp']))                    header('Content-Security-Policy: ' . $h['csp']);
}

// ============ DEFAULT OPTIONS ============
function sropt_defaults() {
    return array(
        // === Speed: NON-OVERLAPPING with BerqWP (keep ON) ===
        'enable_image_dims'    => true,   // Add width/height to prevent CLS
        'enable_font_swap'     => true,   // font-display: swap
        'enable_preconnect'    => true,   // Preconnect hints
        'enable_dns_prefetch'  => true,   // DNS prefetch
        'enable_lcp_preload'   => true,   // Preload LCP image/resource
        'enable_js_delay'      => true,   // Delay jQuery until interaction
        'enable_unused_css'    => false,  // Remove unused CSS (heavy — enable per project)
        'unused_css_safelist'  => '',
        'exclude_css'          => '',
        'exclude_js'           => '',
        'safe_mode'            => false,

        // === Speed: OVERLAPPING with BerqWP (OFF by default) ===
        'enable_lazy_load'     => false,  // BerqWP handles this
        'enable_css_minify'    => false,  // BerqWP handles this
        'enable_critical_css'  => false,  // BerqWP handles this
        'enable_css_defer'     => false,  // BerqWP handles this
        'enable_js_defer'      => false,  // BerqWP handles this
        'enable_js_minify'     => false,  // BerqWP handles this
        'enable_gzip'          => false,  // BerqWP / Cloudflare handles this
        'enable_cache_headers' => false,  // BerqWP / Cloudflare handles this
        'enable_image_compress' => false, // BerqWP handles this
        'image_compress_quality' => 82,
        'enable_page_cache'    => false,  // BerqWP handles this
        'page_cache_ttl'       => 86400,
        'cache_exclude_urls'   => '',
        'cache_ttl'            => 604800,
        'enable_webp'          => false,  // BerqWP handles this
        'webp_quality'         => 80,

        // === SEO Tools (always ON) ===
        'enable_404_monitor'   => true,
        'enable_redirects'     => true,
        'enable_link_checker'  => false,  // Manual trigger only
        'enable_schema'        => true,

        // === Dashboard Connection ===
        'dashboard_url'        => 'https://seo-room-v5-production.up.railway.app',
        'project_id'           => '',
        'connection_code'      => '',
        'license_key'          => '',
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

    // Clear caches on upgrade so new logic takes effect
    $prev_ver = get_option('sropt_version', '0');
    if (version_compare($prev_ver, SEOROOM_VERSION, '<')) {
        foreach (array('critical', 'purged') as $_subdir) {
            $_dir = WP_CONTENT_DIR . '/cache/seoroom/' . $_subdir . '/';
            if (is_dir($_dir)) {
                $files = glob($_dir . '*');
                if ($files) foreach ($files as $f) @unlink($f);
            }
        }
        update_option('sropt_version', SEOROOM_VERSION);
    }

    $dirs = array(
        WP_CONTENT_DIR . '/cache/seoroom/',
        WP_CONTENT_DIR . '/cache/seoroom/pages/',
        WP_CONTENT_DIR . '/cache/seoroom/webp/',
        WP_CONTENT_DIR . '/cache/seoroom/critical/',
        WP_CONTENT_DIR . '/cache/seoroom/purged/',
    );
    foreach ($dirs as $dir) {
        if (!file_exists($dir)) wp_mkdir_p($dir);
    }

    // Clean up old md5-based page cache files (pre-6.2 format)
    $old_pages_dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (is_dir($old_pages_dir)) {
        foreach (glob($old_pages_dir . '*.html') as $old_cache) @unlink($old_cache);
        @unlink($old_pages_dir . 'config.json');
    }
    // Remove old advanced-cache.php drop-in if ours
    $dropin = WP_CONTENT_DIR . '/advanced-cache.php';
    if (file_exists($dropin) && strpos(file_get_contents($dropin), 'SEO Room') !== false) {
        @unlink($dropin);
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
    $purged_dir = WP_CONTENT_DIR . '/cache/seoroom/purged/';
    if (file_exists($purged_dir)) {
        array_map('unlink', array_filter(glob("$purged_dir*.css"), 'is_file'));
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

                <!-- LICENSE -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🔑 License</h2></th></tr>
                <tr>
                    <th>License Key</th>
                    <td>
                        <input type="text" name="sropt_options[license_key]" value="<?php echo esc_attr($options['license_key'] ?? ''); ?>" class="regular-text" placeholder="SR-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" />
                        <p class="description">Provided by The SEO Room. Required for management features.</p>
                    </td>
                </tr>
                <tr>
                    <th>License Status</th>
                    <td>
                        <?php
                        $lic_info = get_option('sropt_license_info', array());
                        if (empty($options['license_key'])) {
                            echo '<span style="color:#f59e0b;font-weight:600;">● No license key</span>';
                            echo '<p class="description">Enter your license key above and save to activate.</p>';
                        } elseif (!empty($lic_info['valid'])) {
                            echo '<span style="color:#22c55e;font-weight:600;">● Active</span>';
                            if (!empty($lic_info['project_name'])) echo ' <span style="color:#666;">— ' . esc_html($lic_info['project_name']) . '</span>';
                            if (!empty($lic_info['expires'])) {
                                $exp = date('j M Y', strtotime($lic_info['expires']));
                                $days = $lic_info['days_remaining'] ?? '';
                                echo '<br><span style="color:#666;font-size:12px;">Expires: ' . esc_html($exp);
                                if ($days) echo ' (' . intval($days) . ' days remaining)';
                                echo '</span>';
                            }
                        } else {
                            echo '<span style="color:#ef4444;font-weight:600;">● ' . esc_html($lic_info['reason'] ?? 'Expired') . '</span>';
                            echo '<p class="description" style="color:#ef4444;">Management features disabled. Existing redirects and schema continue working.</p>';
                        }
                        if (!empty($lic_info['checked_at'])) {
                            echo '<br><span style="color:#999;font-size:11px;">Last checked: ' . esc_html($lic_info['checked_at']) . '</span>';
                        }
                        ?>
                        <br><br>
                        <button type="button" id="sropt_check_license" class="button button-secondary">Check License Now</button>
                        <span id="sropt_license_result" style="margin-left:10px;"></span>
                        <script>
                        document.getElementById('sropt_check_license').addEventListener('click', function() {
                            var btn = this;
                            var result = document.getElementById('sropt_license_result');
                            var key = document.querySelector('input[name="sropt_options[license_key]"]').value;
                            if (!key) { result.innerHTML = '<span style="color:#ef4444;">Enter license key first.</span>'; return; }
                            btn.disabled = true;
                            result.innerHTML = '<span style="color:#666;">Checking...</span>';
                            var fd = new FormData();
                            fd.append('action', 'sropt_ajax_check_license');
                            fd.append('nonce', '<?php echo wp_create_nonce("sropt_license_nonce"); ?>');
                            fd.append('license_key', key);
                            fetch(ajaxurl, { method: 'POST', body: fd })
                            .then(function(r) { return r.json(); })
                            .then(function(resp) {
                                var data = resp.data || {};
                                if (resp.success && data.valid) {
                                    var msg = '✓ Active';
                                    if (data.project_name) msg += ' — ' + data.project_name;
                                    if (data.days_remaining) msg += ' (' + data.days_remaining + ' days remaining)';
                                    result.innerHTML = '<span style="color:#22c55e;font-weight:600;">' + msg + '</span>';
                                } else {
                                    result.innerHTML = '<span style="color:#ef4444;font-weight:600;">✗ ' + (data.reason || resp.data || 'Invalid') + '</span>';
                                }
                            })
                            .catch(function(e) { result.innerHTML = '<span style="color:#ef4444;">✗ ' + e.message + '</span>'; })
                            .finally(function() { btn.disabled = false; });
                        });
                        </script>
                    </td>
                </tr>

                <!-- PLUGIN UPDATES -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🔄 Plugin Updates</h2></th></tr>
                <tr>
                    <th>Version</th>
                    <td>
                        <span style="font-weight:600;">v<?php echo esc_html(SEOROOM_VERSION); ?></span>
                        <?php if (isset($_GET['sropt_updated'])):
                            $f = $_GET['sropt_updated'];
                            $c = $f === '1' ? '#22c55e' : ($f === 'current' ? '#666' : '#ef4444');
                            $t = $f === '1' ? '✓ Updated to v' . esc_html(SEOROOM_VERSION) : ($f === 'current' ? '✓ Already on the latest version' : '✗ ' . esc_html($_GET['sropt_msg'] ?? 'failed'));
                        ?><span style="margin-left:10px;color:<?php echo $c; ?>;font-weight:600;"><?php echo $t; ?></span><?php endif; ?>
                        <p class="description">Updates install automatically every day. Click below to check and install right now.</p>
                        <a href="<?php echo esc_url(wp_nonce_url(admin_url('admin-post.php?action=sropt_self_update'), 'sropt_self_update')); ?>" class="button button-primary">Check for Updates &amp; Install</a>
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

                <!-- UNUSED CSS REMOVAL -->
                <tr><th colspan="2"><h2 style="margin:0;padding:0;font-size:16px;">🧹 Unused CSS Removal</h2></th></tr>
                <tr>
                    <th>Remove Unused CSS</th>
                    <td>
                        <label><input type="checkbox" name="sropt_options[enable_unused_css]" value="1" <?php checked($options['enable_unused_css']); ?> /> Parse HTML and remove CSS rules that don't match any element on the page</label>
                        <p class="description">Analyzes each page's HTML elements, classes, and IDs, then strips CSS selectors that aren't used. Cached per page. <strong>Biggest PageSpeed win — typically 15-20 point improvement on mobile.</strong></p>
                    </td>
                </tr>
                <tr>
                    <th>Safelist Classes</th>
                    <td>
                        <input type="text" name="sropt_options[unused_css_safelist]" value="<?php echo esc_attr($options['unused_css_safelist']); ?>" class="regular-text" />
                        <p class="description">Comma-separated class prefixes/patterns to never remove (e.g., <code>swiper-,slick-,popup-,modal-,menu-item</code>). JS-toggled classes that don't exist in initial HTML.</p>
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
            $page_count = 0;
            $page_iter = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(WP_CONTENT_DIR . '/cache/seoroom/pages/', RecursiveDirectoryIterator::SKIP_DOTS));
            foreach ($page_iter as $f) { if ($f->isFile() && $f->getFilename() === '_index.html') $page_count++; }
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
    // Auto-clear CSS caches on version upgrade (covers auto-updates)
    $prev_ver = get_option('sropt_version', '0');
    if (version_compare($prev_ver, SEOROOM_VERSION, '<')) {
        foreach (array('critical', 'purged') as $_subdir) {
            $_dir = WP_CONTENT_DIR . '/cache/seoroom/' . $_subdir . '/';
            if (is_dir($_dir)) {
                $files = glob($_dir . '*');
                if ($files) foreach ($files as $f) @unlink($f);
            }
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

        // Register Elementor data for REST API access (Design-Safe preview)
        register_post_meta($type, '_elementor_data', [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function() { return current_user_can('edit_posts'); },
        ]);

        // Register Yoast meta fields for REST API writes (On-Page Fix)
        $yoast_fields = [
            '_yoast_wpseo_title',
            '_yoast_wpseo_metadesc',
            '_yoast_wpseo_focuskw',
            '_yoast_wpseo_canonical',
            '_yoast_wpseo_meta-robots-noindex',
        ];
        foreach ($yoast_fields as $field) {
            register_post_meta($type, $field, [
                'show_in_rest'  => true,
                'single'        => true,
                'type'          => 'string',
                'auth_callback' => function() { return current_user_can('edit_posts'); },
            ]);
        }
    }
}, 20);

// ================================================================
// ELEMENTOR DESIGN-SAFE PREVIEW
// Accepts modified _elementor_data, stores in transient, serves via
// filter on get_post_metadata so Elementor renders the modified version.
// ================================================================

// REST endpoint: receive modified elementor data and create preview token
add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/elementor-preview/(?P<page_id>\d+)', [
        'methods' => 'POST',
        'callback' => 'sropt_elementor_preview_create',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
        'args' => [
            'page_id' => ['type' => 'integer', 'required' => true],
            'elementor_data' => ['type' => 'string', 'required' => true],
        ]
    ]);
});

function sropt_elementor_preview_create($request) {
    $page_id = $request->get_param('page_id');
    $sections_json = $request->get_param('sections'); // New sections to add/modify
    $elementor_data = $request->get_param('elementor_data'); // Full modified elementor data (fallback)

    if (!$page_id) {
        return new WP_Error('missing_data', 'page_id required', ['status' => 400]);
    }

    $page = get_post($page_id);
    if (!$page) return new WP_Error('not_found', 'Page not found', ['status' => 404]);

    // Store preview data in transient
    $token = wp_generate_password(32, false);
    set_transient('seoroom_preview_' . $token, [
        'page_id' => $page_id,
        'sections' => $sections_json ? json_decode($sections_json, true) : null,
        'elementor_data' => $elementor_data,
        'created' => time(),
    ], 600);

    $preview_url = add_query_arg('seoroom_preview', $token, get_permalink($page_id));

    return rest_ensure_response([
        'ok' => true,
        'preview_url' => $preview_url,
        'token' => $token,
        'expires_in' => 600,
    ]);
}

// ============================================================================
// ELEMENTOR PUBLISH — write new section content into _elementor_data (server-side)
// so changes actually render on Elementor pages. Falls back signals when not Elementor.
// ============================================================================
add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/publish-elementor/(?P<page_id>\d+)', [
        'methods' => 'POST',
        'callback' => 'sropt_publish_elementor',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});

function sropt_norm_text($s) {
    $s = wp_strip_all_tags((string)$s);
    $s = html_entity_decode($s, ENT_QUOTES);
    $s = strtolower($s);
    $s = preg_replace('/[^a-z0-9]+/', ' ', $s);
    return trim($s);
}
function sropt_word_set($s) {
    $set = [];
    foreach (explode(' ', sropt_norm_text($s)) as $w) { if (strlen($w) >= 4) $set[$w] = 1; }
    return $set;
}
function sropt_shared_count($setA, $str) {
    $shared = 0;
    foreach (sropt_word_set($str) as $w => $_) { if (isset($setA[$w])) $shared++; }
    return $shared;
}

// Recursively walk Elementor elements, replacing text-editor + heading widgets that match a section
function sropt_walk_elements(&$elements, &$bodySecs, &$headSecs, &$count, &$log) {
    if (!is_array($elements)) return;
    foreach ($elements as &$el) {
        if (!is_array($el)) continue;
        $type = isset($el['elType']) ? $el['elType'] : '';
        $widget = isset($el['widgetType']) ? $el['widgetType'] : '';
        if ($type === 'widget' && isset($el['settings']) && is_array($el['settings'])) {
            if ($widget === 'text-editor' && isset($el['settings']['editor'])) {
                $cur = $el['settings']['editor'];
                $bestIdx = -1; $bestShared = 0;
                foreach ($bodySecs as $i => $sec) {
                    if ($sec['used']) continue;
                    $sh = sropt_shared_count($sec['set'], $cur);
                    if ($sh > $bestShared) { $bestShared = $sh; $bestIdx = $i; }
                }
                if ($bestIdx >= 0 && $bestShared >= 3) {
                    $log[] = ['widget'=>'text-editor', 'shared'=>$bestShared, 'from'=>mb_substr(wp_strip_all_tags($cur),0,40), 'to'=>mb_substr(wp_strip_all_tags($bodySecs[$bestIdx]['draft']),0,40)];
                    $el['settings']['editor'] = $bodySecs[$bestIdx]['draft'];
                    $bodySecs[$bestIdx]['used'] = true;
                    $count['text']++;
                } else {
                    $log[] = ['widget'=>'text-editor', 'shared'=>$bestShared, 'unmatched'=>mb_substr(wp_strip_all_tags($cur),0,40)];
                }
            } else if ($widget === 'heading' && isset($el['settings']['title'])) {
                $curNorm = sropt_norm_text($el['settings']['title']);
                foreach ($headSecs as $i => $sec) {
                    if ($sec['used']) continue;
                    if ($sec['norm'] === $curNorm) {
                        $el['settings']['title'] = $sec['draft'];
                        $headSecs[$i]['used'] = true;
                        $count['heading']++;
                        break;
                    }
                }
            }
        }
        if (isset($el['elements']) && is_array($el['elements'])) {
            sropt_walk_elements($el['elements'], $bodySecs, $headSecs, $count, $log);
        }
    }
}

function sropt_publish_elementor($request) {
    $page_id = intval($request->get_param('page_id'));
    $body = $request->get_json_params();
    $sections = (isset($body['sections']) && is_array($body['sections'])) ? $body['sections'] : [];
    $dry = !empty($body['dry']);
    if (!$page_id) return new WP_Error('missing', 'page_id required', ['status' => 400]);

    $raw = get_post_meta($page_id, '_elementor_data', true);
    if (empty($raw)) {
        return rest_ensure_response(['ok' => true, 'elementor' => false, 'message' => 'Page has no Elementor data — use standard publish.']);
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) return new WP_Error('parse', 'Could not parse Elementor data', ['status' => 500]);

    // Build matchable section sets from original_text/heading
    $bodySecs = []; $headSecs = [];
    foreach ($sections as $s) {
        $orig  = isset($s['original_text']) ? $s['original_text'] : '';
        $draft = isset($s['draft_text']) ? $s['draft_text'] : '';
        if ($orig && $draft) $bodySecs[] = ['set' => sropt_word_set($orig), 'draft' => $draft, 'used' => false];
        $oh = isset($s['original_heading']) ? $s['original_heading'] : (isset($s['heading']) ? $s['heading'] : '');
        $dh = isset($s['draft_heading']) ? $s['draft_heading'] : '';
        if ($oh && $dh && sropt_norm_text($oh) !== sropt_norm_text($dh)) $headSecs[] = ['norm' => sropt_norm_text($oh), 'draft' => $dh, 'used' => false];
    }

    $count = ['text' => 0, 'heading' => 0];
    $log = [];
    sropt_walk_elements($data, $bodySecs, $headSecs, $count, $log);

    if ($dry) {
        return rest_ensure_response(['ok' => true, 'elementor' => true, 'dry' => true, 'would_replace' => $count, 'log' => $log]);
    }

    // Back up the ORIGINAL Elementor data once (for rollback) before the first overwrite
    if (!get_post_meta($page_id, '_seoroom_elementor_backup', true)) {
        update_post_meta($page_id, '_seoroom_elementor_backup', $raw);
    }
    // Save updated Elementor data + clear caches so it renders
    update_post_meta($page_id, '_elementor_data', wp_slash(wp_json_encode($data)));
    delete_post_meta($page_id, '_elementor_css');
    if (class_exists('\\Elementor\\Plugin')) {
        try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
    }
    do_action('berqwp_clear_all_cache');
    do_action('berqwp_clear_cache');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
    clean_post_cache($page_id);

    return rest_ensure_response(['ok' => true, 'elementor' => true, 'replaced' => $count]);
}

// ================================================================
// PERMANENT INTERNAL LINKS — write links INTO the page content (post_content or Elementor text
// widgets) so they survive ALL caching (Cloudflare/BerqWP). Reversible via per-page backup.
// ================================================================
add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/insert-links', [
        'methods' => 'POST',
        'callback' => 'sropt_insert_links',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
    register_rest_route('seoroom-opt/v1', '/restore-links', [
        'methods' => 'POST',
        'callback' => 'sropt_restore_links',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});

// Recursively insert links into Elementor text-editor widgets (first matching occurrence, once per link)
function sropt_walk_insert_links(&$elements, &$todo, &$inserted) {
    if (!is_array($elements)) return;
    foreach ($elements as &$el) {
        if (!is_array($el)) continue;
        if ((isset($el['widgetType']) ? $el['widgetType'] : '') === 'text-editor' && isset($el['settings']['editor'])) {
            foreach ($todo as &$l) {
                if ($l['done']) continue;
                $new = sropt_link_first_occurrence($el['settings']['editor'], $l['anchor'], $l['target']);
                if ($new !== $el['settings']['editor']) { $el['settings']['editor'] = $new; $l['done'] = true; $inserted[] = $l['anchor']; }
            }
            unset($l);
        }
        if (isset($el['elements']) && is_array($el['elements'])) sropt_walk_insert_links($el['elements'], $todo, $inserted);
    }
    unset($el);
}

function sropt_insert_links($request) {
    $body  = $request->get_json_params();
    $url   = isset($body['url']) ? trim($body['url']) : '';
    $links = (isset($body['links']) && is_array($body['links'])) ? $body['links'] : [];
    $dry   = !empty($body['dry']);
    $page_id = isset($body['page_id']) ? intval($body['page_id']) : 0;
    if (!$page_id && $url) $page_id = url_to_postid($url);
    if (!$page_id) return rest_ensure_response(['ok' => false, 'message' => 'Could not resolve page from URL', 'url' => $url]);
    if (empty($links)) return rest_ensure_response(['ok' => false, 'message' => 'No links provided']);

    $todo = [];
    foreach ($links as $l) {
        $a = isset($l['anchor']) ? trim($l['anchor']) : '';
        $t = isset($l['target']) ? trim($l['target']) : '';
        if ($a !== '' && $t !== '') $todo[] = ['anchor' => $a, 'target' => $t, 'done' => false];
    }
    if (empty($todo)) return rest_ensure_response(['ok' => false, 'message' => 'No valid links']);

    $isElementor = (get_post_meta($page_id, '_elementor_edit_mode', true) === 'builder') && get_post_meta($page_id, '_elementor_data', true);
    $inserted = [];

    if ($isElementor) {
        $raw = get_post_meta($page_id, '_elementor_data', true);
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            $fixed = wp_slash($raw); // auto-repair over-unslashed data
            $data = json_decode($fixed, true);
            if (is_array($data)) { $raw = $fixed; }
            else return rest_ensure_response(['ok' => false, 'message' => 'Could not parse Elementor data']);
        }
        sropt_walk_insert_links($data, $todo, $inserted);
        if (!$dry && $inserted) {
            if (!get_post_meta($page_id, '_seoroom_links_backup_elem', true)) update_post_meta($page_id, '_seoroom_links_backup_elem', wp_slash($raw));
            update_post_meta($page_id, '_elementor_data', wp_slash(wp_json_encode($data)));
            delete_post_meta($page_id, '_elementor_css');
            if (class_exists('\\Elementor\\Plugin')) { try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {} }
        }
    } else {
        $post = get_post($page_id);
        if (!$post) return rest_ensure_response(['ok' => false, 'message' => 'Post not found']);
        $content = $post->post_content;
        $orig = $content;
        foreach ($todo as &$l) {
            if ($l['done']) continue;
            $new = sropt_link_first_occurrence($content, $l['anchor'], $l['target']);
            if ($new !== $content) { $content = $new; $l['done'] = true; $inserted[] = $l['anchor']; }
        }
        unset($l);
        if (!$dry && $inserted) {
            if (!get_post_meta($page_id, '_seoroom_links_backup_content', true)) update_post_meta($page_id, '_seoroom_links_backup_content', wp_slash($orig));
            wp_update_post(['ID' => $page_id, 'post_content' => $content]);
        }
    }

    $failed = [];
    foreach ($todo as $l) if (!$l['done']) $failed[] = $l['anchor'];

    if (!$dry && $inserted) {
        do_action('berqwp_clear_all_cache'); do_action('berqwp_clear_cache');
        if (function_exists('wp_cache_flush')) wp_cache_flush();
        clean_post_cache($page_id);
    }
    return rest_ensure_response(['ok' => true, 'page_id' => $page_id, 'elementor' => (bool)$isElementor, 'inserted' => $inserted, 'failed' => $failed, 'dry' => $dry]);
}

function sropt_restore_links($request) {
    $body = $request->get_json_params();
    $url  = isset($body['url']) ? trim($body['url']) : '';
    $page_id = isset($body['page_id']) ? intval($body['page_id']) : 0;
    if (!$page_id && $url) $page_id = url_to_postid($url);
    if (!$page_id) return rest_ensure_response(['ok' => false, 'message' => 'Could not resolve page']);
    $restored = false;
    $elem = get_post_meta($page_id, '_seoroom_links_backup_elem', true);
    if (!empty($elem)) {
        if (json_decode($elem) !== null) {   // only restore a VALID backup
            update_post_meta($page_id, '_elementor_data', wp_slash($elem));
            delete_post_meta($page_id, '_seoroom_links_backup_elem');
            delete_post_meta($page_id, '_elementor_css');
            if (class_exists('\\Elementor\\Plugin')) { try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {} }
            $restored = true;
        }
    }
    $content = get_post_meta($page_id, '_seoroom_links_backup_content', true);
    if (!empty($content)) {
        wp_update_post(['ID' => $page_id, 'post_content' => $content]);
        delete_post_meta($page_id, '_seoroom_links_backup_content');
        $restored = true;
    }
    do_action('berqwp_clear_all_cache');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
    clean_post_cache($page_id);
    return rest_ensure_response(['ok' => true, 'restored' => $restored]);
}

// ================================================================
// HUB CONTENT BLOCK — append an in-content links block (e.g. a list of all child pages) into a hub page,
// so empty index pages (/a-f, /service-areas …) actually link their children in BODY content. Reversible.
// ================================================================
add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/insert-content-block', [
        'methods' => 'POST', 'callback' => 'sropt_insert_content_block',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
    register_rest_route('seoroom-opt/v1', '/restore-content-block', [
        'methods' => 'POST', 'callback' => 'sropt_restore_content_block',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
    register_rest_route('seoroom-opt/v1', '/rebuild-elementor', [
        'methods' => 'POST', 'callback' => 'sropt_rebuild_elementor',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});

// Replace a page's Elementor data with a clean, valid single-section page built from $html. Used to
// recover a page whose Elementor data was corrupted. Backs up the current (possibly broken) data first.
function sropt_rebuild_elementor($request) {
    $body = $request->get_json_params();
    $url  = isset($body['url']) ? trim($body['url']) : '';
    $page_id = isset($body['page_id']) ? intval($body['page_id']) : 0;
    $html = isset($body['html']) ? $body['html'] : '';
    if (!$page_id && $url) $page_id = url_to_postid($url);
    if (!$page_id) return rest_ensure_response(['ok' => false, 'message' => 'Could not resolve page']);
    if (!$html) return rest_ensure_response(['ok' => false, 'message' => 'No HTML provided']);
    $gid = function() { return substr(md5(uniqid('', true)), 0, 7); };
    // Keep a one-time copy of whatever is there now (even if corrupt), so nothing is ever truly lost.
    $cur = get_post_meta($page_id, '_elementor_data', true);
    if (!get_post_meta($page_id, '_seoroom_rebuild_backup', true)) update_post_meta($page_id, '_seoroom_rebuild_backup', wp_slash($cur));
    $data = [[
        'id' => $gid(), 'elType' => 'section', 'settings' => new stdClass(), 'elements' => [[
            'id' => $gid(), 'elType' => 'column', 'settings' => ['_column_size' => 100, '_inline_size' => null], 'elements' => [[
                'id' => $gid(), 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => ['editor' => $html]
            ]]
        ]]
    ]];
    update_post_meta($page_id, '_elementor_edit_mode', 'builder');
    update_post_meta($page_id, '_elementor_data', wp_slash(wp_json_encode($data)));
    delete_post_meta($page_id, '_elementor_css');
    if (class_exists('\\Elementor\\Plugin')) { try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {} }
    do_action('berqwp_clear_all_cache'); do_action('berqwp_clear_cache');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
    clean_post_cache($page_id);
    return rest_ensure_response(['ok' => true, 'page_id' => $page_id, 'rebuilt' => true]);
}

function sropt_insert_content_block($request) {
    $body = $request->get_json_params();
    $url  = isset($body['url']) ? trim($body['url']) : '';
    $page_id = isset($body['page_id']) ? intval($body['page_id']) : 0;
    $html = isset($body['html']) ? $body['html'] : '';
    $dry  = !empty($body['dry']);
    $marker = isset($body['marker']) && $body['marker'] ? preg_replace('/[^a-z0-9_-]/i', '', $body['marker']) : 'seoroom-hub';
    if (!$page_id && $url) $page_id = url_to_postid($url);
    if (!$page_id) return rest_ensure_response(['ok' => false, 'message' => 'Could not resolve page from URL', 'url' => $url]);
    if (!$html) return rest_ensure_response(['ok' => false, 'message' => 'No HTML block provided']);

    $isElementor = (get_post_meta($page_id, '_elementor_edit_mode', true) === 'builder') && get_post_meta($page_id, '_elementor_data', true);
    if ($dry) return rest_ensure_response(['ok' => true, 'page_id' => $page_id, 'elementor' => (bool)$isElementor, 'dry' => true]);
    $gid = function() { return substr(md5(uniqid('', true)), 0, 7); };

    if ($isElementor) {
        $raw = get_post_meta($page_id, '_elementor_data', true);
        if (strpos($raw, $marker) !== false) return rest_ensure_response(['ok' => true, 'page_id' => $page_id, 'already' => true]);
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            // Auto-repair: older builds saved backups un-slashed, which could over-unslash the live data.
            // Re-applying wp_slash restores valid JSON. The save below writes it back correctly.
            $fixed = wp_slash($raw);
            $data = json_decode($fixed, true);
            if (is_array($data)) { $raw = $fixed; }
            else return rest_ensure_response(['ok' => false, 'message' => 'Could not parse Elementor data']);
        }
        $section = [
            'id' => $gid(), 'elType' => 'section', 'settings' => new stdClass(), 'elements' => [[
                'id' => $gid(), 'elType' => 'column', 'settings' => ['_column_size' => 100, '_inline_size' => null], 'elements' => [[
                    'id' => $gid(), 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => ['editor' => $html]
                ]]
            ]]
        ];
        $data[] = $section;
        if (!get_post_meta($page_id, '_seoroom_hub_backup_elem', true)) update_post_meta($page_id, '_seoroom_hub_backup_elem', wp_slash($raw));
        update_post_meta($page_id, '_elementor_data', wp_slash(wp_json_encode($data)));
        delete_post_meta($page_id, '_elementor_css');
        if (class_exists('\\Elementor\\Plugin')) { try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {} }
    } else {
        $post = get_post($page_id);
        if (!$post) return rest_ensure_response(['ok' => false, 'message' => 'Post not found']);
        if (strpos($post->post_content, $marker) !== false) return rest_ensure_response(['ok' => true, 'page_id' => $page_id, 'already' => true]);
        if (!get_post_meta($page_id, '_seoroom_hub_backup_content', true)) update_post_meta($page_id, '_seoroom_hub_backup_content', wp_slash($post->post_content));
        wp_update_post(['ID' => $page_id, 'post_content' => $post->post_content . "\n\n" . $html]);
    }
    do_action('berqwp_clear_all_cache'); do_action('berqwp_clear_cache');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
    clean_post_cache($page_id);
    return rest_ensure_response(['ok' => true, 'page_id' => $page_id, 'elementor' => (bool)$isElementor, 'inserted' => true]);
}

function sropt_restore_content_block($request) {
    $body = $request->get_json_params();
    $url  = isset($body['url']) ? trim($body['url']) : '';
    $page_id = isset($body['page_id']) ? intval($body['page_id']) : 0;
    if (!$page_id && $url) $page_id = url_to_postid($url);
    if (!$page_id) return rest_ensure_response(['ok' => false, 'message' => 'Could not resolve page']);
    $restored = false;
    $elem = get_post_meta($page_id, '_seoroom_hub_backup_elem', true);
    if (!empty($elem)) {
        if (json_decode($elem) !== null) {   // only restore a VALID backup — never overwrite a live page with corrupt JSON
            update_post_meta($page_id, '_elementor_data', wp_slash($elem));
            delete_post_meta($page_id, '_seoroom_hub_backup_elem'); delete_post_meta($page_id, '_elementor_css');
            if (class_exists('\\Elementor\\Plugin')) { try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {} }
            $restored = true;
        }
    }
    $content = get_post_meta($page_id, '_seoroom_hub_backup_content', true);
    if (!empty($content)) {
        wp_update_post(['ID' => $page_id, 'post_content' => $content]);
        delete_post_meta($page_id, '_seoroom_hub_backup_content');
        $restored = true;
    }
    do_action('berqwp_clear_all_cache'); if (function_exists('wp_cache_flush')) wp_cache_flush(); clean_post_cache($page_id);
    return rest_ensure_response(['ok' => true, 'restored' => $restored]);
}

// Restore the original Elementor data (rollback for an Elementor publish)
add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/restore-elementor/(?P<page_id>\d+)', [
        'methods' => 'POST',
        'callback' => 'sropt_restore_elementor',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});
function sropt_restore_elementor($request) {
    $page_id = intval($request->get_param('page_id'));
    if (!$page_id) return new WP_Error('missing', 'page_id required', ['status' => 400]);
    $backup = get_post_meta($page_id, '_seoroom_elementor_backup', true);
    if (empty($backup)) return rest_ensure_response(['ok' => false, 'message' => 'No Elementor backup found']);
    update_post_meta($page_id, '_elementor_data', wp_slash($backup));
    delete_post_meta($page_id, '_elementor_css');
    if (class_exists('\\Elementor\\Plugin')) {
        try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
    }
    do_action('berqwp_clear_all_cache');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
    clean_post_cache($page_id);
    return rest_ensure_response(['ok' => true, 'restored' => true]);
}

// Purge caches for a page (called after publish so changes show immediately)
add_action('rest_api_init', function() {
    register_rest_route('seoroom-opt/v1', '/clear-cache(?:/(?P<page_id>\d+))?', [
        'methods' => 'POST',
        'callback' => 'sropt_clear_cache_route',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
    register_rest_route('seoroom-opt/v1', '/fix-alt', [
        'methods' => 'POST',
        'callback' => 'sropt_fix_alt_route',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});
function sropt_clear_cache_route($request) {
    $page_id = intval($request->get_param('page_id'));
    if ($page_id) {
        delete_post_meta($page_id, '_elementor_css');
        clean_post_cache($page_id);
        do_action('berqwp_clear_url', get_permalink($page_id));
    }
    // Global purges across common cache plugins
    do_action('berqwp_clear_all_cache');
    do_action('berqwp_clear_cache');
    do_action('litespeed_purge_all');
    do_action('rocket_clean_domain');
    do_action('w3tc_flush_all');
    do_action('wpfc_clear_all_cache');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
    if (class_exists('\\Elementor\\Plugin')) {
        try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
    }
    return rest_ensure_response(['ok' => true, 'cleared' => true, 'page_id' => $page_id]);
}

// Set alt text reliably from INSIDE WordPress. The attachment's _wp_attachment_image_alt is what
// Elementor image widgets render, so this works on template/suburb pages the REST API can't reach.
// Safe + idempotent: only sets alt + clears cache. Body: { page_id, items: [{src, alt}] }.
function sropt_fix_alt_route($request) {
    $p = $request->get_json_params();
    $page_id = intval(isset($p['page_id']) ? $p['page_id'] : 0);
    $items = (isset($p['items']) && is_array($p['items'])) ? $p['items'] : array();
    // Filename stem: strip query, size suffix (-1024x683) and extension → matches any rendered variant.
    $stem = function($u) {
        $f = strtok(basename((string)$u), '?');
        return preg_replace('/(-\d+x\d+)?\.[A-Za-z0-9]+$/', '', $f);
    };
    $results = array();
    $media_set = 0;

    // 1) Attachment alt meta — what Elementor outputs by default.
    global $wpdb;
    foreach ($items as $it) {
        $src = isset($it['src']) ? $it['src'] : '';
        $alt = isset($it['alt']) ? wp_strip_all_tags($it['alt']) : '';
        if (!$src || !$alt) continue;
        $aid = attachment_url_to_postid($src);
        if (!$aid) {
            $like = '%' . $wpdb->esc_like($stem($src)) . '%';
            $aid = (int) $wpdb->get_var($wpdb->prepare(
                "SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key='_wp_attached_file' AND meta_value LIKE %s LIMIT 1", $like
            ));
        }
        if ($aid) {
            update_post_meta($aid, '_wp_attachment_image_alt', $alt);
            $media_set++;
            $results[] = array('src' => $src, 'attachment_id' => $aid, 'where' => 'attachment_meta');
        } else {
            $results[] = array('src' => $src, 'attachment_id' => 0, 'where' => 'not_in_media_library');
        }
    }

    // 2) Elementor data on the page — set alt on image / background_image widgets by stem match.
    $el_changed = false;
    if ($page_id) {
        $raw = get_post_meta($page_id, '_elementor_data', true);
        if (!empty($raw)) {
            $data = json_decode($raw, true);
            if (is_array($data)) {
                $walk = function(&$els) use (&$walk, $items, $stem) {
                    foreach ($els as &$el) {
                        if (isset($el['settings']) && is_array($el['settings'])) {
                            foreach (array('image', 'background_image') as $key) {
                                if (isset($el['settings'][$key]['url'])) {
                                    $u = $el['settings'][$key]['url'];
                                    foreach ($items as $it) {
                                        if (!empty($it['src']) && $stem($u) !== '' && $stem($u) === $stem($it['src'])) {
                                            $el['settings'][$key]['alt'] = wp_strip_all_tags($it['alt']);
                                        }
                                    }
                                }
                            }
                        }
                        if (!empty($el['elements'])) $walk($el['elements']);
                    }
                };
                $walk($data);
                $new = wp_json_encode($data);
                if ($new && $new !== $raw) {
                    update_post_meta($page_id, '_elementor_data', wp_slash($new));
                    $el_changed = true;
                }
            }
        }

        // 3) Classic/Gutenberg post content <img> tags (stem match → any size variant).
        $post = get_post($page_id);
        if ($post && !empty($post->post_content) && strpos($post->post_content, '<img') !== false) {
            $content = $post->post_content; $orig = $content;
            foreach ($items as $it) {
                if (empty($it['src']) || empty($it['alt'])) continue;
                $needle = preg_quote($stem($it['src']), '/');
                if ($needle === '') continue;
                $safe = esc_attr(wp_strip_all_tags($it['alt']));
                $content = preg_replace_callback('/<img\b[^>]*' . $needle . '[^>]*>/i', function($m) use ($safe) {
                    $tag = $m[0];
                    if (preg_match('/\salt\s*=\s*("|\').*?\1/i', $tag)) {
                        return preg_replace('/\salt\s*=\s*("|\').*?\1/i', ' alt="' . $safe . '"', $tag, 1);
                    }
                    return preg_replace('/<img\b/i', '<img alt="' . $safe . '"', $tag, 1);
                }, $content);
            }
            if ($content !== $orig) {
                wp_update_post(array('ID' => $page_id, 'post_content' => wp_slash($content)));
            }
        }

        // 4) Clear caches so the live page regenerates.
        delete_post_meta($page_id, '_elementor_css');
        clean_post_cache($page_id);
        do_action('berqwp_clear_url', get_permalink($page_id));
    }
    do_action('berqwp_clear_all_cache');
    do_action('berqwp_clear_cache');
    do_action('litespeed_purge_all');
    do_action('rocket_clean_domain');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
    if (class_exists('\\Elementor\\Plugin')) { try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {} }

    return rest_ensure_response(array('ok' => true, 'media_set' => $media_set, 'elementor_changed' => $el_changed, 'results' => $results));
}

// Style published FAQ <details> accordions to match the site — STATIC CSS in <head> (survives cache/JS optimizers),
// scoped to the post-content container so it styles the FAQ wherever it sits. Accent auto-detected (CSS var + fallback).
add_action('wp_head', 'sropt_faq_css', 99);
function sropt_faq_css() {
    if (is_admin() || !is_singular()) return;
    $containers = ['.entry-content', '.entry-summary', '.elementor-widget-theme-post-content', '.post-content', 'article', 'main'];
    $sel = function($suffix) use ($containers) {
        return implode(',', array_map(function($c) use ($suffix) { return $c . ' ' . $suffix; }, $containers));
    };
    echo "\n<style id=\"seoroom-faq-css\">\n";
    echo $sel('details') . "{background:#fff;border:1px solid #eceef3;border-radius:12px;margin:0 0 12px;overflow:hidden;box-shadow:0 4px 14px rgba(2,6,23,.05)}\n";
    echo $sel('summary') . "{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;font-weight:700;font-size:16px;line-height:1.4;color:var(--seoroom-accent,#1d72d6)}\n";
    echo $sel('summary::-webkit-details-marker') . "{display:none}\n";
    echo $sel('summary::after') . "{content:\"\\2193\";flex:0 0 auto;width:28px;height:28px;border-radius:50%;background:var(--seoroom-accent,#1d72d6);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;line-height:1;transition:transform .2s}\n";
    echo $sel('details[open] summary::after') . "{transform:rotate(180deg)}\n";
    echo $sel('details>*:not(summary)') . "{padding:2px 20px 18px;color:#5b6470;line-height:1.7;font-size:15px;margin:0}\n";
    echo "</style>\n";
    // Tiny accent detector — sets --seoroom-accent to the site's brand colour. Marked no-optimize so BerqWP leaves it alone.
    echo '<script data-no-optimize="1" data-no-defer="1" data-cfasync="false">';
    echo '(function(){if(!document.querySelector("details"))return;function p(s){var m=(s||"").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?/);return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:+m[4]]:null;}function v(r){if(!r||r[3]<0.4)return false;var mx=Math.max(r[0],r[1],r[2]),mn=Math.min(r[0],r[1],r[2]);return mx>=70&&mn<=225&&(mx-mn)>=28;}var c={};function a(x,w){var r=p(x);if(!v(r))return;var k="rgb("+r[0]+","+r[1]+","+r[2]+")";c[k]=(c[k]||0)+(w||1);}function s(q,pr,mx,w){var e=document.querySelectorAll(q),n=0;for(var i=0;i<e.length;i++){if(e[i].closest("footer"))continue;try{a(getComputedStyle(e[i])[pr],w);}catch(x){}if(++n>=mx)break;}}s("a","color",50,1);s(".elementor-button,button,.btn,[class*=cta]","backgroundColor",14,2);s("h2,h3","color",16,1);var best=null,bn=0;for(var k in c){if(c[k]>bn){bn=c[k];best=k;}}if(best)document.documentElement.style.setProperty("--seoroom-accent",best);})();';
    echo "</script>\n";
}

// Elementor Design-Safe Preview: intercept page output and modify rendered HTML
// This works with ALL widgets (standard + third-party) because we modify AFTER rendering
add_action('template_redirect', 'sropt_elementor_preview_intercept', 1);
function sropt_elementor_preview_intercept() {
    if (empty($_GET['seoroom_preview'])) return;
    if (!is_singular()) return;

    // Preview pages must NEVER be cached — a cached preview serves a stale copy (old plugin output, wrong
    // sections) which is exactly the "preview not updating / not showing everything" symptom.
    if (!defined('DONOTCACHEPAGE')) define('DONOTCACHEPAGE', true);
    nocache_headers();
    do_action('litespeed_control_set_nocache', 'seoroom preview');
    do_action('berqwp_exclude_url', $_SERVER['REQUEST_URI'] ?? '');
    add_filter('berqwp_is_cacheable', '__return_false');

    $page_id = get_queried_object_id();
    $sections = null;
    $dashboard_url = '';

    // Method 1: Hash-based (sections encoded in URL hash — read client-side by injected script)
    if ($_GET['seoroom_preview'] === 'hash') {
        $sections = ['__hash_mode__']; // Non-empty marker so output buffer runs
        $dashboard_url = sanitize_url($_GET['dash'] ?? '');
    }
    // Method 2: POST data (browser sends sections directly)
    else if ($_GET['seoroom_preview'] === 'post' && !empty($_POST['seoroom_sections'])) {
        $sections = json_decode(wp_unslash($_POST['seoroom_sections']), true);
        $dashboard_url = sanitize_url($_POST['seoroom_dashboard'] ?? '');
    }
    // Method 3: Transient token (server created it via REST API)
    else {
        $token = sanitize_text_field($_GET['seoroom_preview']);
        $preview = get_transient('seoroom_preview_' . $token);
        if (!$preview) return;
        if (intval($preview['page_id']) !== $page_id) return;
        $sections = $preview['sections'] ?? [];
        $dashboard_url = rtrim((sropt_get_options())['dashboard_url'] ?? '', '/');
    }

    if ($sections === null) return;

    // Preview pages must never be cached by Cloudflare / BerqWP / page cache — they're per-request
    if (!defined('DONOTCACHEPAGE')) define('DONOTCACHEPAGE', true);
    nocache_headers();
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

    // Determine mode before starting buffer
    $is_hash_mode = ($_GET['seoroom_preview'] === 'hash');

    // Start output buffering — inject section-preview.js for CLIENT-SIDE replacement
    ob_start(function($html) use ($sections, $page_id, $is_hash_mode) {
        if (empty($html) || strlen($html) < 500) return $html;

        $script = '';

        // Hash mode: sections come from URL hash (decoded client-side)
        if ($is_hash_mode) {
            $script .= '<script id="seo-hash-loader">
(function(){
  var h = window.location.hash;
  if (!h || h.indexOf("seodata=") === -1) { console.log("[SEO Room] No hash data found"); return; }
  var encoded = h.split("seodata=")[1];
  try {
    var json = decodeURIComponent(escape(atob(encoded)));
    var el = document.createElement("script");
    el.id = "seo-section-data";
    el.type = "application/json";
    el.textContent = json;
    document.body.appendChild(el);
    console.log("[SEO Room] Loaded " + JSON.parse(json).length + " sections from URL hash");
  } catch(e) { console.error("[SEO Room] Hash decode error:", e); }
})();
</script>';
        }
        // Server mode: sections already available as JSON
        else if (!empty($sections) && $sections[0] !== '__hash_mode__') {
            $script .= '<script id="seo-section-data" type="application/json">' . wp_json_encode($sections) . '</script>';
        }

        // Load section-preview.js from the DASHBOARD (always the latest — JS changes go live on deploy).
        // SECURITY: the origin comes ONLY from the dashboard URL saved in plugin settings — never from a
        // user-supplied ?dash= value. Honouring an attacker-controlled ?dash= would be reflected XSS:
        // any external domain's JavaScript could be injected into the front-end via a crafted preview URL.
        $dash = rtrim((sropt_get_options())['dashboard_url'] ?? '', '/');
        if ($dash && strpos($dash, 'https://') === 0) {
            $script .= '<script src="' . esc_url($dash . '/section-preview.js?v=' . time()) . '"></script>';
            $script .= '<script>console.log("[SEO Room Preview] Injected ' . count($sections) . ' sections, script: dashboard (live)");</script>';
        } else {
            // Fallback: inline the bundled copy (CDN/page caches can never serve a stale copy)
            $preview_js = @file_get_contents(SEOROOM_PATH . 'section-preview.js');
            if ($preview_js !== false && strlen($preview_js) > 100) {
                $preview_js = str_replace('</script>', '<\/script>', $preview_js);
                $script .= '<script id="seoroom-section-preview-inline" data-v="' . esc_attr(SEOROOM_VERSION) . '">' . $preview_js . '</script>';
                $script .= '<script>console.log("[SEO Room Preview] Injected ' . count($sections) . ' sections, script: inline v' . SEOROOM_VERSION . '");</script>';
            } else {
                $script .= '<script src="' . esc_url(SEOROOM_URL . 'section-preview.js') . '?v=' . SEOROOM_VERSION . '" defer></script>';
                $script .= '<script>console.log("[SEO Room Preview] Injected ' . count($sections) . ' sections, script: external fallback");</script>';
            }
        }

        // Preview bar with match count
        $original_url = get_permalink($page_id);
        $bar = '<div class="seo-preview-bar" style="position:fixed;bottom:0;left:0;right:0;z-index:999999;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;padding:14px 24px;font-size:14px;display:flex;align-items:center;gap:16px;box-shadow:0 -4px 20px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;">'
            . '<strong style="font-size:15px;">SEO Room Preview</strong>'
            . '<span style="background:rgba(255,255,255,0.2);padding:3px 10px;border-radius:5px;font-size:12px;">Design-Safe Mode</span>'
            . '<span id="seo-match-count" style="opacity:0.9;">Loading preview...</span>'
            . '<a href="' . esc_url($original_url) . '" style="margin-left:auto;color:#e0e7ff;text-decoration:underline;font-size:13px;">View original &rarr;</a>'
            . '</div>';

        // Add details/summary CSS for FAQ accordions
        $faq_css = '<style>details{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;overflow:hidden}details summary{padding:12px 16px;cursor:pointer;font-weight:600;font-size:15px;color:#1e293b;list-style:none;display:flex;align-items:center;gap:8px}details summary::-webkit-details-marker{display:none}details summary::before{content:"+";display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:rgba(99,102,241,0.1);color:#6366f1;font-weight:700;font-size:14px;flex-shrink:0}details[open] summary::before{content:"−"}details[open] summary{border-bottom:1px solid #e2e8f0}details p,details div{padding:12px 16px 12px 46px;font-size:14px;line-height:1.7;color:#475569}.seo-new-badge{position:absolute;top:8px;right:12px;font-size:10px;font-weight:700;color:#fff;background:#22c55e;padding:3px 10px;border-radius:4px;z-index:10}</style>';

        $html = str_replace('</head>', $faq_css . '</head>', $html);
        $html = str_replace('</body>', $script . $bar . '</body>', $html);

        return $html;
    });

}

// Add preview bar to the page when in preview mode (legacy — now handled in output buffer)
// Kept for backward compat but the output buffer above handles everything

// ================================================================
// VISUAL EDITOR MODE — allows iframe embedding + makes text editable
// Activated by ?seoroom_edit=TOKEN query parameter
// ================================================================
add_action('template_redirect', 'sropt_visual_editor_mode', 1);
function sropt_visual_editor_mode() {
    if (empty($_GET['seoroom_edit'])) return;
    if (!is_singular()) return;

    $token = sanitize_text_field($_GET['seoroom_edit']);
    $preview = get_transient('seoroom_preview_' . $token);
    if (!$preview) return;

    // Remove X-Frame-Options to allow iframe embedding from our dashboard
    header_remove('X-Frame-Options');
    // Allow embedding from our dashboard URL
    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'], '/');
    if ($dashboard_url) {
        header("Content-Security-Policy: frame-ancestors 'self' $dashboard_url");
    }

    // Inject editing script into the page footer
    add_action('wp_footer', function() {
        ?>
        <style>
            .seoroom-editable { cursor: text !important; transition: box-shadow 0.2s; }
            .seoroom-editable:hover { box-shadow: 0 0 0 2px rgba(99,102,241,0.3) !important; }
            .seoroom-editable:focus { box-shadow: 0 0 0 2px #6366f1 !important; outline: none !important; }
            .seoroom-edit-indicator { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 99999; background: #6366f1; color: #fff; padding: 8px 20px; border-radius: 20px; font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.3); transition: opacity 0.5s; }
        </style>
        <div class="seoroom-edit-indicator">Click any text section to edit — changes sync to SEO Room Dashboard</div>
        <script>
        (function() {
            var selectors = [
                '.elementor-widget-text-editor .elementor-widget-container',
                '.elementor-widget-heading .elementor-heading-title',
                'article .entry-content > *'
            ];
            var editables = [];
            selectors.forEach(function(sel) {
                document.querySelectorAll(sel).forEach(function(el) {
                    if (el.closest('nav, footer, form, header, .site-footer, .elementor-location-footer, .seoroom-edit-indicator')) return;
                    el.contentEditable = 'true';
                    el.classList.add('seoroom-editable');
                    editables.push(el);
                    el.addEventListener('input', function() {
                        var allContent = editables.map(function(e) { return { html: e.innerHTML, text: e.textContent.trim().substring(0, 80) }; });
                        window.parent.postMessage({ type: 'seoroom-content-edited', editables: allContent }, '*');
                    });
                });
            });
            // Make accordion titles editable too
            document.querySelectorAll('.acc_title, .elementor-tab-title, .elementor-toggle-title, [class*="acc_title"]').forEach(function(el) {
                el.contentEditable = 'true';
                el.classList.add('seoroom-editable');
            });

            // Listen for draft content from parent dashboard
            // SIMPLE APPROACH: find main text widgets, replace their content with draft
            // Only touches .elementor-widget-text-editor — never testimonials, CTAs, forms, footer
            window.addEventListener('message', function(e) {
                if (!e.data || e.data.type !== 'seoroom-apply-draft') return;
                var fullContent = e.data.fullContent || '';
                if (!fullContent || fullContent.length < 50) {
                    var ind = document.querySelector('.seoroom-edit-indicator');
                    if (ind) { ind.textContent = 'No content to apply — rewrite first'; ind.style.background = '#ef4444'; }
                    window.parent.postMessage({ type: 'seoroom-draft-applied', count: 0, total: 0 }, '*');
                    return;
                }

                // Find ONLY text widgets in main content (skip footer/nav/header/sidebar)
                var skipSel = 'footer,nav,header,.site-footer,.elementor-location-footer,.footer-widget,#footer,.widget-area,.sidebar,form';
                var mainWidgets = [];
                document.querySelectorAll('.elementor-widget-text-editor .elementor-widget-container').forEach(function(tw) {
                    if (tw.closest(skipSel)) return;
                    if (tw.textContent.trim().length < 30) return;
                    mainWidgets.push(tw);
                });

                console.log('[SEO Room Apply] Found ' + mainWidgets.length + ' main text widgets');

                if (mainWidgets.length === 0) {
                    var ind = document.querySelector('.seoroom-edit-indicator');
                    if (ind) { ind.textContent = 'No text widgets found on this page'; ind.style.background = '#ef4444'; }
                    window.parent.postMessage({ type: 'seoroom-draft-applied', count: 0, total: 0 }, '*');
                    return;
                }

                // Replace each text widget with the full draft content
                // Widget 1 gets ALL the content (it's the main content block)
                // If multiple widgets, split draft evenly
                var applied = 0;
                if (mainWidgets.length === 1) {
                    // Single main widget — put all content in it
                    mainWidgets[0].innerHTML = fullContent;
                    mainWidgets[0].style.setProperty('border-left', '3px solid #22c55e', 'important');
                    applied = 1;
                } else {
                    // Multiple widgets — split by H2 headings and distribute
                    // First, try to match widget count to content chunks
                    var parts = fullContent.split(/(?=<h2[^>]*>)/i).filter(function(p) { return p.trim().length > 20; });
                    if (parts.length === 0) parts = [fullContent];

                    // Distribute parts across widgets
                    var partsPerWidget = Math.ceil(parts.length / mainWidgets.length);
                    mainWidgets.forEach(function(tw, wi) {
                        var start = wi * partsPerWidget;
                        var end = Math.min(start + partsPerWidget, parts.length);
                        if (start >= parts.length) return;
                        var chunk = parts.slice(start, end).join('');
                        if (chunk.trim().length > 10) {
                            tw.innerHTML = chunk;
                            tw.style.setProperty('border-left', '3px solid #22c55e', 'important');
                            applied++;
                        }
                    });
                }

                console.log('[SEO Room Apply] Replaced ' + applied + ' text widget(s)');
                window.parent.postMessage({ type: 'seoroom-draft-applied', count: applied, total: mainWidgets.length }, '*');
                var ind = document.querySelector('.seoroom-edit-indicator');
                if (ind) {
                    ind.textContent = applied + ' content section(s) updated — scroll down to review';
                    ind.style.background = '#22c55e';
                }
            });

            // Tell parent we're ready
            window.parent.postMessage({ type: 'seoroom-editor-ready', editables: editables.length }, '*');

            setTimeout(function() {
                var ind = document.querySelector('.seoroom-edit-indicator');
                if (ind) ind.style.opacity = '0.4';
            }, 4000);
            console.log('[SEO Room] Visual editor active: ' + editables.length + ' editable sections');
        })();
        </script>
        <?php
    }, 999);
}

// Add preview bar to the page when in preview mode
add_action('wp_footer', 'sropt_elementor_preview_bar');
function sropt_elementor_preview_bar() {
    if (empty($_GET['seoroom_preview'])) return;
    $token = sanitize_text_field($_GET['seoroom_preview']);
    $preview = get_transient('seoroom_preview_' . $token);
    if (!$preview) return;

    $original_url = get_permalink($preview['page_id']);
    ?>
    <div style="position:fixed;bottom:0;left:0;right:0;z-index:999999;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;padding:14px 24px;font-size:14px;display:flex;align-items:center;gap:16px;box-shadow:0 -4px 20px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <strong style="font-size:15px;">SEO Room Preview</strong>
        <span style="background:rgba(255,255,255,0.2);padding:3px 10px;border-radius:5px;font-size:12px;">Design-Safe Mode</span>
        <span style="opacity:0.9;">Content changes are temporary — not published</span>
        <a href="<?php echo esc_url($original_url); ?>" style="margin-left:auto;color:#e0e7ff;text-decoration:underline;font-size:13px;">View original &rarr;</a>
    </div>
    <?php
}

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

// Speed optimization output buffer DISABLED — BerqWP handles all speed optimizations.
// Plugin focuses on: schema injection, 404 monitor, redirects, broken links, dashboard connector.
// add_action('template_redirect', 'sropt_start_buffer', 1);
function sropt_start_buffer() {
    // Disabled — BerqWP conflicts with output buffer HTML rewriting
    return;
}

function sropt_process_html($html) {
    if (empty($html) || strlen($html) < 100) return $html;
    if (stripos($html, '<html') === false && stripos($html, '<!DOCTYPE') === false) return $html;

    $options = sropt_get_options();
    $is_safe = $options['safe_mode'];

    // ---- UNUSED CSS REMOVAL ---- (must run BEFORE critical CSS so critical extraction works on purged CSS)
    if ($options['enable_unused_css'] && !$is_safe) {
        $html = sropt_remove_unused_css($html, $options);
    }

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

    // LCP preload injection (runs on fully rendered HTML)
    $html = sropt_lcp_buffer_handler($html);

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
// UNUSED CSS REMOVAL — Parse HTML, keep only matching CSS selectors
// ================================================================

function sropt_remove_unused_css($html, $options) {
    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    $cache_key = md5(($_SERVER['HTTP_HOST'] ?? '') . $uri);
    $purge_dir = WP_CONTENT_DIR . '/cache/seoroom/purged/';
    $purge_file = $purge_dir . $cache_key . '.css';
    $purge_url = content_url('cache/seoroom/purged/' . $cache_key . '.css');

    // Check cache (7-day TTL)
    if (file_exists($purge_file) && (time() - filemtime($purge_file)) < 604800) {
        // Replace all local stylesheets with single purged CSS file
        return sropt_replace_stylesheets_with_purged($html, $purge_url, $options);
    }

    // ---- STEP 1: Extract used tokens from HTML ----
    $used = sropt_extract_html_tokens($html);
    if (empty($used['classes']) && empty($used['ids']) && empty($used['tags'])) return $html;

    // ---- STEP 2: Collect all local CSS ----
    // Extract stylesheet URLs
    preg_match_all('/<link\b[^>]*rel\s*=\s*["\']stylesheet["\'][^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>/i', $html, $m1);
    preg_match_all('/<link\b[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*rel\s*=\s*["\']stylesheet["\'][^>]*>/i', $html, $m2);
    $stylesheet_urls = array_unique(array_merge($m1[1] ?? [], $m2[1] ?? []));

    $all_css = '';
    $local_urls = array();
    foreach ($stylesheet_urls as $url) {
        $path = sropt_url_to_local_path($url);
        if ($path && file_exists($path) && is_readable($path)) {
            $content = @file_get_contents($path);
            if ($content) {
                // Resolve relative URLs
                $css_dir_url = dirname($url);
                $content = preg_replace_callback('/url\s*\(\s*["\']?(?!data:|https?:|\/\/)([^"\')\s]+)["\']?\s*\)/i', function($m) use ($css_dir_url) {
                    return 'url(' . $css_dir_url . '/' . $m[1] . ')';
                }, $content);
                $all_css .= $content . "\n";
                $local_urls[] = $url;
            }
        }
    }

    // Also include inline <style> blocks
    preg_match_all('/<style\b[^>]*>(.*?)<\/style>/is', $html, $style_matches);
    if (!empty($style_matches[1])) {
        foreach ($style_matches[1] as $inline) {
            if (strpos($inline, 'application/ld+json') !== false) continue;
            if (strpos($inline, 'seoroom-critical-css') !== false) continue;
            $all_css .= $inline . "\n";
        }
    }

    if (empty(trim($all_css))) return $html;

    // ---- STEP 3: Build safelist ----
    $safelist = sropt_build_safelist($options);

    // ---- STEP 4: Purge unused rules ----
    $purged_css = sropt_purge_css($all_css, $used, $safelist);

    if (empty($purged_css)) return $html;

    // ---- STEP 5: Cache the purged CSS ----
    if (!file_exists($purge_dir)) wp_mkdir_p($purge_dir);
    @file_put_contents($purge_file, $purged_css);

    // ---- STEP 6: Replace stylesheets with purged file ----
    return sropt_replace_stylesheets_with_purged($html, $purge_url, $options);
}


/**
 * Extract all element tags, classes, and IDs from the HTML.
 */
function sropt_extract_html_tokens($html) {
    $tags = array();
    $classes = array();
    $ids = array();
    $attrs = array();

    // Extract all HTML tags and their attributes
    preg_match_all('/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/s', $html, $tag_matches, PREG_SET_ORDER);

    foreach ($tag_matches as $tm) {
        $tag = strtolower($tm[1]);
        $tags[$tag] = true;
        $attr_str = $tm[2] ?? '';

        // Extract classes
        if (preg_match('/\bclass\s*=\s*["\']([^"\']*)["\']/', $attr_str, $cls)) {
            $class_list = preg_split('/\s+/', trim($cls[1]));
            foreach ($class_list as $c) {
                $c = trim($c);
                if ($c !== '') $classes[$c] = true;
            }
        }

        // Extract IDs
        if (preg_match('/\bid\s*=\s*["\']([^"\']*)["\']/', $attr_str, $id)) {
            $id_val = trim($id[1]);
            if ($id_val !== '') $ids[$id_val] = true;
        }

        // Extract data attributes (for attribute selectors)
        if (preg_match_all('/\b(data-[a-zA-Z0-9_-]+)/', $attr_str, $data_attrs)) {
            foreach ($data_attrs[1] as $da) $attrs[strtolower($da)] = true;
        }

        // Extract role, type, aria attributes
        if (preg_match_all('/\b(role|type|aria-[a-zA-Z0-9_-]+)\s*=\s*["\']([^"\']*)["\']/', $attr_str, $attr_vals, PREG_SET_ORDER)) {
            foreach ($attr_vals as $av) {
                $attrs[strtolower($av[1]) . '=' . $av[2]] = true;
                $attrs[strtolower($av[1])] = true;
            }
        }
    }

    return array(
        'tags'    => $tags,
        'classes' => $classes,
        'ids'     => $ids,
        'attrs'   => $attrs,
    );
}


/**
 * Build safelist of patterns that should never be removed.
 * Includes dynamic classes added by JS (menus, popups, sliders, etc.)
 */
function sropt_build_safelist($options) {
    // Default safelist: common JS-toggled classes and state classes
    $defaults = array(
        // State classes (toggled by JS)
        'active', 'open', 'show', 'visible', 'hidden', 'expanded', 'collapsed',
        'is-active', 'is-open', 'is-visible', 'is-hidden', 'is-expanded', 'is-collapsed',
        'has-', 'no-', 'not-',
        // WordPress
        'menu-item', 'sub-menu', 'current-menu', 'page-item', 'widget',
        'wp-block', 'wp-element', 'has-', 'is-layout',
        'logged-in', 'admin-bar',
        // Elementor
        'elementor-', 'e-', 'eicon-', 'dialog-', 'flatpickr-',
        // Common JS libraries
        'swiper-', 'slick-', 'owl-', 'fancybox-', 'magnific-', 'lightbox',
        'modal', 'popup', 'dropdown', 'tooltip', 'toast',
        // Animations / transitions
        'animate-', 'aos-', 'wow-', 'fade', 'slide',
        // Accessibility
        'screen-reader', 'sr-only', 'visually-hidden', 'aria-',
        // Common responsive
        'mobile-', 'tablet-', 'desktop-',
        // Forms
        'wpcf7', 'form-', 'input-', 'select2', 'chosen-',
    );

    // Add user-defined safelist
    $user_safelist = array_filter(array_map('trim', explode(',', $options['unused_css_safelist'] ?? '')));
    $all_patterns = array_merge($defaults, $user_safelist);

    return $all_patterns;
}


/**
 * Core CSS purging: remove selectors that don't match anything in the HTML.
 */
function sropt_purge_css($all_css, $used, $safelist) {
    $purged = '';

    // Always keep :root, *, html, body, @font-face, @keyframes, @charset, @import
    if (preg_match_all('/:root\s*\{[^}]+\}/i', $all_css, $roots)) {
        foreach ($roots[0] as $r) $purged .= $r . "\n";
    }

    // Keep @font-face declarations
    if (preg_match_all('/@font-face\s*\{[^}]+\}/i', $all_css, $fonts)) {
        foreach ($fonts[0] as $f) $purged .= $f . "\n";
    }

    // Keep @keyframes (animations may be triggered by JS)
    if (preg_match_all('/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/i', $all_css, $kfs)) {
        foreach ($kfs[0] as $kf) $purged .= $kf . "\n";
    }

    // Keep @charset, @import
    if (preg_match_all('/@(?:charset|import)\s[^;]+;/i', $all_css, $at_rules)) {
        foreach ($at_rules[0] as $r) $purged .= $r . "\n";
    }

    // Strip @font-face, @keyframes, @charset, @import from working CSS
    $work_css = preg_replace('/@font-face\s*\{[^}]+\}/i', '', $all_css);
    $work_css = preg_replace('/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/i', '', $work_css);
    $work_css = preg_replace('/@(?:charset|import)\s[^;]+;/i', '', $work_css);
    $work_css = preg_replace('/:root\s*\{[^}]+\}/i', '', $work_css);

    // Extract @media blocks
    $media_blocks = array();
    $work_css = preg_replace_callback('/@media\s*([^{]+)\{((?:[^{}]*\{[^}]*\})*[^}]*)\}/i', function($m) use (&$media_blocks) {
        $media_blocks[] = array('query' => trim($m[1]), 'content' => $m[2]);
        return '';
    }, $work_css);

    // Process non-media rules
    preg_match_all('/([^{}@]+)\{([^{}]+)\}/', $work_css, $rules, PREG_SET_ORDER);
    foreach ($rules as $rule) {
        $selector = trim($rule[1]);
        $declarations = trim($rule[2]);
        if (empty($selector) || empty($declarations)) continue;
        if (preg_match('/^\d+%$|^from$|^to$/i', $selector)) continue;

        if (sropt_selector_is_used($selector, $used, $safelist)) {
            $purged .= $selector . '{' . $declarations . "}\n";
        }
    }

    // Process @media blocks
    foreach ($media_blocks as $mb) {
        // Skip print-only
        if (preg_match('/\bprint\b/i', $mb['query']) && !preg_match('/\bscreen\b/i', $mb['query'])) continue;

        $inner_purged = '';
        preg_match_all('/([^{}@]+)\{([^{}]+)\}/', $mb['content'], $inner_rules, PREG_SET_ORDER);
        foreach ($inner_rules as $ir) {
            $sel = trim($ir[1]);
            $decl = trim($ir[2]);
            if (empty($sel) || empty($decl)) continue;
            if (preg_match('/^\d+%$|^from$|^to$/i', $sel)) continue;

            if (sropt_selector_is_used($sel, $used, $safelist)) {
                $inner_purged .= $sel . '{' . $decl . "}\n";
            }
        }

        if (!empty($inner_purged)) {
            $purged .= '@media ' . $mb['query'] . '{' . $inner_purged . "}\n";
        }
    }

    return $purged;
}


/**
 * Check if a CSS selector group matches anything in the HTML.
 * A selector group like "h1, .hero, #main" is used if ANY part matches.
 */
function sropt_selector_is_used($selector_group, $used, $safelist) {
    // Universal selectors always match
    if (preg_match('/^\s*\*\s*$/', $selector_group)) return true;

    // Split compound selectors (comma-separated)
    $selectors = explode(',', $selector_group);

    foreach ($selectors as $selector) {
        $selector = trim($selector);
        if (empty($selector)) continue;

        // Always keep: html, body, *, ::before, ::after, :root
        if (preg_match('/^(?:html|body|\*|:root)\b/i', $selector)) return true;
        if (strpos($selector, '::') !== false) {
            // Pseudo-element — check if the base selector is used
            $base = preg_replace('/::[\w-]+.*$/', '', $selector);
            if (empty(trim($base)) || preg_match('/^(?:html|body|\*|:root)\b/i', trim($base))) return true;
            if (sropt_single_selector_matches(trim($base), $used, $safelist)) return true;
            continue;
        }

        if (sropt_single_selector_matches($selector, $used, $safelist)) return true;
    }

    return false;
}


/**
 * Check if a single selector (not comma-separated) matches the HTML tokens.
 */
function sropt_single_selector_matches($selector, $used, $safelist) {
    // Check safelist patterns first
    foreach ($safelist as $pattern) {
        if (empty($pattern)) continue;
        // Check if any part of the selector matches a safelist pattern
        if (strpos($selector, $pattern) !== false) return true;
    }

    // Extract all classes from selector (.classname)
    if (preg_match_all('/\.([a-zA-Z_][a-zA-Z0-9_-]*)/', $selector, $cls_matches)) {
        $all_match = true;
        foreach ($cls_matches[1] as $cls) {
            if (!isset($used['classes'][$cls])) {
                $all_match = false;
                break;
            }
        }
        if ($all_match && !empty($cls_matches[1])) return true;
        // If classes don't match, this selector might still match via other parts
        // but classes are the primary indicator — if a class doesn't exist, skip
        if (!empty($cls_matches[1])) return false;
    }

    // Extract IDs from selector (#idname)
    if (preg_match_all('/#([a-zA-Z_][a-zA-Z0-9_-]*)/', $selector, $id_matches)) {
        foreach ($id_matches[1] as $id) {
            if (isset($used['ids'][$id])) return true;
        }
        // ID specified but not found
        return false;
    }

    // Extract tag names from selector
    if (preg_match('/^([a-zA-Z][a-zA-Z0-9]*)/', $selector, $tag_match)) {
        $tag = strtolower($tag_match[1]);
        if (isset($used['tags'][$tag])) return true;
    }

    // Attribute selectors [data-xxx], [role=...], etc.
    if (preg_match_all('/\[([^\]]+)\]/', $selector, $attr_matches)) {
        foreach ($attr_matches[1] as $attr_expr) {
            $attr_name = preg_replace('/[~|^$*]?=.*$/', '', $attr_expr);
            $attr_name = strtolower(trim($attr_name, '"\''));
            if (isset($used['attrs'][$attr_name])) return true;
        }
    }

    // If we couldn't parse the selector, keep it (safe default)
    return true;
}


/**
 * Replace local <link rel="stylesheet"> tags with a single purged CSS file.
 */
function sropt_replace_stylesheets_with_purged($html, $purge_url, $options) {
    $excludes = array_filter(array_map('trim', explode(',', $options['exclude_css'])));
    $never_replace = array('admin-bar', 'dashicons', 'wp-admin');
    $site_host = parse_url(home_url(), PHP_URL_HOST);
    $replaced_count = 0;
    $insert_pos = null;

    $html = preg_replace_callback('/<link\b([^>]*rel\s*=\s*["\']stylesheet["\'][^>]*)>/i', function($matches) use ($excludes, $never_replace, $site_host, &$replaced_count, &$insert_pos) {
        $attrs = $matches[1];
        $href = '';
        if (preg_match('/href\s*=\s*["\']([^"\']+)["\']/i', $attrs, $href_match)) {
            $href = $href_match[1];
        }
        $handle = '';
        if (preg_match('/id\s*=\s*["\']([^"\']+)-css["\']/i', $attrs, $id_match)) {
            $handle = $id_match[1];
        }

        // Don't replace excluded, admin, or external stylesheets
        if (in_array($handle, $never_replace)) return $matches[0];
        foreach ($excludes as $exc) {
            if ($handle === $exc || strpos($href, $exc) !== false) return $matches[0];
        }

        // Only replace local stylesheets
        $href_host = parse_url($href, PHP_URL_HOST);
        if ($href_host && $href_host !== $site_host) return $matches[0];

        // Can we resolve this to a local file?
        $path = sropt_url_to_local_path($href);
        if (!$path || !file_exists($path)) return $matches[0];

        $replaced_count++;

        // Keep first replaced tag position for inserting purged link
        if ($replaced_count === 1) {
            return '<!--SEOROOM_PURGED_CSS_PLACEHOLDER-->';
        }

        // Remove subsequent local stylesheets (they're all merged into purged file)
        return '';
    }, $html);

    if ($replaced_count > 0) {
        // Insert the single purged CSS link where the first stylesheet was
        $purged_link = '<link rel="stylesheet" id="seoroom-purged-css" href="' . esc_url($purge_url) . '?v=' . SEOROOM_VERSION . '" media="all" />';
        $html = str_replace('<!--SEOROOM_PURGED_CSS_PLACEHOLDER-->', $purged_link, $html);
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

// JS delay DISABLED — BerqWP handles JS optimization.
// add_action('template_redirect', 'sropt_delay_js_start', 2);
function sropt_delay_js_start() {
    // Disabled — BerqWP handles JS delay/defer
    return;

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

    // Page Cache — serve cached HTML directly from Apache (zero PHP)
    if ($options['enable_page_cache'] && !$options['safe_mode']) {
        $cache_path = str_replace(ABSPATH, '', WP_CONTENT_DIR) . '/cache/seoroom/pages';
        $rules .= "# Page Cache — zero-PHP serving\n";
        $rules .= "<IfModule mod_rewrite.c>\n";
        $rules .= "  RewriteEngine On\n";
        $rules .= "  # Skip logged-in users\n";
        $rules .= "  RewriteCond %{HTTP_COOKIE} !wordpress_logged_in_ [NC]\n";
        $rules .= "  RewriteCond %{HTTP_COOKIE} !comment_author_ [NC]\n";
        $rules .= "  RewriteCond %{HTTP_COOKIE} !wp-postpass_ [NC]\n";
        $rules .= "  # Only GET requests\n";
        $rules .= "  RewriteCond %{REQUEST_METHOD} GET\n";
        $rules .= "  # Skip admin, login, API, feeds\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !^/wp-admin [NC]\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !^/wp-login [NC]\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !^/wp-json [NC]\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !^/wp-cron [NC]\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !/feed [NC]\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !/cart [NC]\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !/checkout [NC]\n";
        $rules .= "  RewriteCond %{REQUEST_URI} !/my-account [NC]\n";
        $rules .= "  # Check if cache file exists (directory-based: /host/path/_index.html)\n";
        $rules .= "  RewriteCond %{DOCUMENT_ROOT}/" . $cache_path . "/%{HTTP_HOST}%{REQUEST_URI}/_index.html -f\n";
        $rules .= "  RewriteRule ^(.*)$ /" . $cache_path . "/%{HTTP_HOST}%{REQUEST_URI}/_index.html [L,T=text/html]\n";
        $rules .= "</IfModule>\n\n";
    }

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
// PRELOAD LCP IMAGE — Rendered HTML detection (universal)
// ================================================================
// Instead of guessing at wp_head time, we inject the preload tag via
// the output buffer AFTER the full HTML is rendered. This catches:
//   - Elementor background images (inline style or data-settings)
//   - Theme page-header backgrounds (Onum, Astra, etc.)
//   - Featured images, hero <img> tags
//   - Any CSS background-image in the above-fold area
// The wp_head hook is kept as an early hint for simple cases.

add_action('wp_head', 'sropt_preload_hints', 1);
function sropt_preload_hints() {
    if (is_admin()) return;
    $options = sropt_get_options();
    if (!$options['enable_lcp_preload']) return;

    $preload_url = '';

    if (is_singular()) {
        $post = get_post();

        // 1. Check Elementor data for hero background image
        if (!$preload_url && $post) {
            $elementor_data = get_post_meta($post->ID, '_elementor_data', true);
            if ($elementor_data && is_string($elementor_data)) {
                $data = json_decode($elementor_data, true);
                if (is_array($data)) {
                    $checked = 0;
                    foreach ($data as $element) {
                        if ($checked >= 3) break;
                        $bg_url = sropt_find_elementor_bg($element, 0);
                        if ($bg_url) { $preload_url = $bg_url; break; }
                        $checked++;
                    }
                }
            }
        }

        // 2. Try post thumbnail (featured image)
        if (!$preload_url && has_post_thumbnail()) {
            $thumb_id = get_post_thumbnail_id();
            $thumb_url = wp_get_attachment_image_url($thumb_id, 'full');
            if ($thumb_url) $preload_url = $thumb_url;
        }
    }

    // Store early-detected URL for the output buffer to use/override
    $GLOBALS['sropt_lcp_early'] = $preload_url;

    // Check if the output buffer will run (it handles the real detection)
    $options2 = sropt_get_options();
    $is_safe = $options2['safe_mode'];
    $buffer_active = (!$is_safe && ($options2['enable_css_minify'] || $options2['enable_js_minify'] || $options2['enable_critical_css'] || $options2['enable_unused_css']))
        || $options2['enable_font_swap'] || $options2['enable_preconnect'] || $options2['enable_dns_prefetch'];

    // Only emit from wp_head if the output buffer WON'T run (safe mode, no options)
    // When buffer runs, it will inject the preload after seeing the full HTML
    if (!$buffer_active && $preload_url) {
        $type = '';
        if (preg_match('/\.webp(\?|$)/i', $preload_url)) $type = ' type="image/webp"';
        elseif (preg_match('/\.png(\?|$)/i', $preload_url)) $type = ' type="image/png"';
        echo '<link rel="preload" as="image" href="' . esc_url($preload_url) . '"' . $type . ' fetchpriority="high">' . "\n";
    }
}

/**
 * Output buffer handler: scan rendered HTML for the actual LCP image.
 * Runs AFTER the full page is rendered so we can see theme headers,
 * inline styles, and all images.
 */
function sropt_lcp_buffer_handler($html) {
    // LCP handler disabled — the regex-based HTML rewriting causes layout shifts
    // and performance regressions on sites with BerqWP. The wp_head hook
    // (sropt_lcp_preload_head) handles simple preload cases instead.
    return $html;

    if (is_admin() || empty($html)) return $html;
    $options = sropt_get_options();
    if (!$options['enable_lcp_preload']) return $html;

    $debug_info = array('handler' => 'running');

    // Don't skip even if BerqWP has a preload — BerqWP may preload the wrong image
    // and still lazy-load the hero background via lazy-berqwpbg class.
    // We check later to avoid duplicate preload tags.
    $has_existing_preload = preg_match('/<link[^>]*rel=["\']preload["\'][^>]*fetchpriority=["\']high["\']/i', $html);

    $preload_url = '';

    // Strategy 1: Find background-image in page-header/hero/banner sections
    // Use a simpler, more robust approach: first find the hero element, then extract URL from it
    $hero_element = '';
    if (preg_match('/<(?:div|section|header)\b[^>]*class="[^"]*(?:page-header|hero|banner|masthead)[^"]*"[^>]*>/i', $html, $hero_match)) {
        $hero_element = $hero_match[0];
        $debug_info['hero_found'] = substr($hero_element, 0, 80);
        // Extract background-image URL from the hero element's style attribute
        // Handle: url("..."), url('...'), url(...), url(&quot;...&quot;)
        if (preg_match('/background-image:\s*url\((?:&quot;|["\'])?([^"\')\s&>]+)/i', $hero_element, $url_match)) {
            $url = $url_match[1];
            $debug_info['hero_url'] = substr($url, 0, 60);
            if (preg_match('/\.(jpg|jpeg|png|webp|avif)/i', $url)) {
                $preload_url = $url;
                $debug_info['strategy'] = 1;
            }
        } else {
            $debug_info['hero_no_bg'] = true;
        }
    }

    // Also check Elementor sections
    if (!$preload_url) {
        if (preg_match('/<(?:div|section)\b[^>]*class="[^"]*elementor-(?:section|top-section|element)[^"]*"[^>]*style="[^"]*background-image:\s*url\((?:&quot;|["\'])?([^"\')\s&>]+)/i', $html, $el_match)) {
            $url = $el_match[1];
            if (preg_match('/\.(jpg|jpeg|png|webp|avif)/i', $url)) {
                $preload_url = $url;
                $debug_info['strategy'] = '1e';
            }
        }
    }

    // Strategy 2: Find theme CSS background in <style> tags for page-header
    if (!$preload_url) {
        $q = '(?:&quot;|["\'])';
        if (preg_match('/\.page-header\s*\{[^}]*background(?:-image)?\s*:[^}]*url\(' . $q . '?([^"\')\s&]+)' . $q . '?\)/i', $html, $m)) {
            if (preg_match('/\.(jpg|jpeg|png|webp|avif)/i', $m[1])) {
                $preload_url = $m[1];
            }
        }
    }

    // Strategy 3: Use the early-detected URL (Elementor data or featured image)
    if (!$preload_url && !empty($GLOBALS['sropt_lcp_early'])) {
        $preload_url = $GLOBALS['sropt_lcp_early'];
    }

    // Strategy 4: First large <img> in the top portion of HTML (first 5000 chars after <body>)
    if (!$preload_url) {
        $body_pos = stripos($html, '<body');
        $top_html = $body_pos !== false ? substr($html, $body_pos, 5000) : substr($html, 0, 8000);
        if (preg_match_all('/<img\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\'][^>]*>/i', $top_html, $img_matches)) {
            foreach ($img_matches[1] as $src) {
                // Skip tiny/icon images by filename pattern
                if (preg_match('/(\d+)x(\d+)/', $src, $dims)) {
                    if (intval($dims[1]) < 400 && intval($dims[2]) < 400) continue;
                }
                if (preg_match('/(gravatar|avatar|icon|logo|pixel|tracking|badge|button|spinner)/i', $src)) continue;
                $preload_url = $src;
                break;
            }
        }
    }

    // === CRITICAL: Strip BerqWP lazy-bg classes from hero/LCP elements ===
    // BerqWP adds lazy-berqwpbg (and similar) to background-image elements,
    // lazy-loading them via JS. This adds ~600ms resource load delay to LCP.
    // Strip these classes from page-header/hero/banner containers ALWAYS,
    // regardless of whether we found a preload_url.
    $lazy_bg_classes = 'lazy-berqwpbg|lazy-bg|lazyload-bg';
    $hero_selectors = 'page-header|single-page-header|hero|banner|masthead';
    $html = preg_replace_callback(
        '/<(div|section|header)\b([^>]*class="[^"]*(?:' . $hero_selectors . ')[^"]*"[^>]*)>/i',
        function($m) use ($lazy_bg_classes) {
            $tag = $m[1];
            $attrs = $m[2];
            // Strip lazy-bg class names
            $attrs = preg_replace('/\b(' . $lazy_bg_classes . ')\b/i', '', $attrs);
            // Clean up double spaces in class attr
            $attrs = preg_replace('/class="([^"]*)"/i', '', $attrs, -1, $count, 0);
            // Re-extract and clean class value
            if (preg_match('/class="([^"]*)"/i', $m[2], $cls)) {
                $clean = preg_replace('/\b(' . $lazy_bg_classes . ')\b/i', '', $cls[1]);
                $clean = preg_replace('/\s+/', ' ', trim($clean));
                $attrs = preg_replace('/class="[^"]*"/i', 'class="' . $clean . '"', $m[2]);
            }
            return '<' . $tag . $attrs . '>';
        },
        $html
    );

    // Also strip lazy-berqwpbg from ANY element that has the LCP background-image URL
    if ($preload_url) {
        $escaped_bg = preg_quote($preload_url, '/');
        $html = preg_replace_callback(
            '/<(div|section|header)\b([^>]*style="[^"]*' . $escaped_bg . '[^"]*"[^>]*)>/i',
            function($m) use ($lazy_bg_classes) {
                $tag = $m[1];
                $attrs = $m[2];
                if (preg_match('/class="([^"]*)"/i', $attrs, $cls)) {
                    $clean = preg_replace('/\b(' . $lazy_bg_classes . ')\b/i', '', $cls[1]);
                    $clean = preg_replace('/\s+/', ' ', trim($clean));
                    $attrs = preg_replace('/class="[^"]*"/i', 'class="' . $clean . '"', $attrs);
                }
                return '<' . $tag . $attrs . '>';
            },
            $html
        );
    }

    // === LCP BOOST: modify HTML for faster LCP ===
    if ($preload_url) {
        // Add preconnect to BerqWP CDN if the LCP URL is from their CDN
        $preconnect = '';
        if (preg_match('#https?://([^/]+\.cdn\.digitaloceanspaces\.com)#i', $preload_url, $cdn_m)) {
            $cdn_origin = 'https://' . $cdn_m[1];
            // Only add if not already present
            if (stripos($html, $cdn_origin) === false || !preg_match('/<link[^>]*rel=["\']preconnect["\'][^>]*' . preg_quote($cdn_m[1], '/') . '/i', $html)) {
                $preconnect = '<link rel="preconnect" href="' . $cdn_origin . '" crossorigin>' . "\n";
            }
        }

        $type = '';
        if (preg_match('/\.webp(\?|$)/i', $preload_url)) $type = ' type="image/webp"';
        elseif (preg_match('/\.png(\?|$)/i', $preload_url)) $type = ' type="image/png"';
        elseif (preg_match('/\.svg(\?|$)/i', $preload_url)) $type = ' type="image/svg+xml"';

        // Only add preload if BerqWP doesn't already have one for this URL
        $skip_preload = false;
        if ($has_existing_preload) {
            $escaped_check = preg_quote($preload_url, '/');
            if (preg_match('/<link[^>]*rel=["\']preload["\'][^>]*href=["\'][^"\']*' . $escaped_check . '/i', $html)) {
                $skip_preload = true; // BerqWP already preloads this exact URL
            }
        }

        if (!$skip_preload) {
            $tag = '<link rel="preload" as="image" href="' . esc_url($preload_url) . '"' . $type . ' fetchpriority="high">' . "\n";
        } else {
            $tag = '';
        }

        // Insert preconnect + preload after <meta charset> or at start of <head>
        $inject = $preconnect . $tag;
        if ($inject) {
            if (preg_match('/<meta[^>]*charset[^>]*>/i', $html, $meta_match, PREG_OFFSET_CAPTURE)) {
                $pos = $meta_match[0][1] + strlen($meta_match[0][0]);
                $html = substr($html, 0, $pos) . "\n" . $inject . substr($html, $pos);
            } elseif (($head_pos = stripos($html, '<head>')) !== false) {
                $html = substr($html, 0, $head_pos + 6) . "\n" . $inject . substr($html, $head_pos + 6);
            }
        }

        // A) Add fetchpriority="high" to the actual LCP <img> element (if LCP is an image tag)
        //    Also remove loading="lazy" which kills LCP
        $escaped_url = preg_quote($preload_url, '/');
        if (preg_match('/<img\b[^>]*src=["\']' . $escaped_url . '["\'][^>]*>/i', $html, $img_match, PREG_OFFSET_CAPTURE)) {
            $img_tag = $img_match[0][0];
            $img_pos = $img_match[0][1];
            $new_tag = $img_tag;
            $new_tag = preg_replace('/\s*loading\s*=\s*["\']lazy["\']/i', '', $new_tag);
            if (!preg_match('/fetchpriority/i', $new_tag)) {
                $new_tag = preg_replace('/<img\b/i', '<img fetchpriority="high"', $new_tag);
            }
            if (!preg_match('/loading\s*=/i', $new_tag)) {
                $new_tag = preg_replace('/<img\b/i', '<img loading="eager"', $new_tag);
            }
            if ($new_tag !== $img_tag) {
                $html = substr($html, 0, $img_pos) . $new_tag . substr($html, $img_pos + strlen($img_tag));
            }
        }

        // B) Inject hidden <img> for background-image LCP elements
        //    If the LCP is a CSS background-image (not an <img> tag), inject a hidden
        //    <img> right after <body> with fetchpriority="high". The browser discovers
        //    it immediately, starts loading, and it's cached by the time the
        //    background-image renders. Zero visual/layout impact.
        // Check if LCP is a background-image (not an <img> tag)
        $is_bg_lcp = !empty($hero_element) || preg_match('/\.page-header\s*\{[^}]*background(?:-image)?\s*:[^}]*url\(/i', $html);
        if ($is_bg_lcp) {
            $hidden_img = '<img src="' . esc_url($preload_url) . '" fetchpriority="high" loading="eager" aria-hidden="true" alt="" style="position:absolute;width:0;height:0;overflow:hidden;clip:rect(0,0,0,0);pointer-events:none">';
            // Insert right after the opening <body...> tag
            if (preg_match('/<body\b[^>]*>/i', $html, $body_match, PREG_OFFSET_CAPTURE)) {
                $body_end = $body_match[0][1] + strlen($body_match[0][0]);
                $html = substr($html, 0, $body_end) . "\n" . $hidden_img . "\n" . substr($html, $body_end);
            }
        }

        // C) For ALL above-fold images (first 2 after <body>): remove lazy, add eager
        $body_start = stripos($html, '<body');
        if ($body_start !== false) {
            $above_fold = substr($html, $body_start, 6000);
            $af_count = 0;
            $above_fold = preg_replace_callback('/<img\b([^>]*)>/i', function($m) use (&$af_count) {
                $af_count++;
                if ($af_count > 2) return $m[0];
                $attrs = $m[1];
                $attrs = preg_replace('/\s*loading\s*=\s*["\']lazy["\']/i', '', $attrs);
                if (!preg_match('/loading\s*=/i', $attrs)) {
                    $attrs = ' loading="eager"' . $attrs;
                }
                if ($af_count === 1 && !preg_match('/fetchpriority/i', $attrs)) {
                    $attrs = ' fetchpriority="high"' . $attrs;
                }
                return '<img' . $attrs . '>';
            }, $above_fold);
            $html = substr($html, 0, $body_start) . $above_fold . substr($html, $body_start + 6000);
        }
    }

    // Debug comment (remove after testing)
    $debug_info['preload_url'] = $preload_url ? substr($preload_url, -30) : 'none';
    $html = str_replace('</head>', '<meta name="sropt-lcp-debug" content="' . esc_attr(json_encode($debug_info)) . '">' . "\n" . '</head>', $html);

    return $html;
}

// Note: sropt_lcp_buffer_handler is called from sropt_process_html (output buffer).
// When the buffer isn't active (safe mode), the wp_head hook handles simple cases.

/**
 * Recursively search Elementor element data for a background image URL.
 */
function sropt_find_elementor_bg($element, $depth) {
    if ($depth > 2 || !is_array($element)) return '';
    $settings = isset($element['settings']) ? $element['settings'] : array();

    if (!empty($settings['background_image']['url'])) {
        $url = $settings['background_image']['url'];
        if (preg_match('/\.(jpg|jpeg|png|webp|avif)/i', $url)) return $url;
    }

    if (!empty($settings['background_slideshow_gallery']) && is_array($settings['background_slideshow_gallery'])) {
        $first = $settings['background_slideshow_gallery'][0];
        if (!empty($first['url']) && preg_match('/\.(jpg|jpeg|png|webp|avif)/i', $first['url'])) return $first['url'];
    }

    if (!empty($element['elements']) && is_array($element['elements'])) {
        $checked = 0;
        foreach ($element['elements'] as $child) {
            if ($checked >= 3) break;
            $url = sropt_find_elementor_bg($child, $depth + 1);
            if ($url) return $url;
            $checked++;
        }
    }
    return '';
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
// PAGE CACHE — .htaccess mod_rewrite (serves cached HTML with ZERO PHP)
// ================================================================

// Strip tracking params from URI for consistent cache keys
function sropt_clean_uri($uri) {
    $path = parse_url($uri, PHP_URL_PATH);
    $query = parse_url($uri, PHP_URL_QUERY);
    if (empty($query)) return $path;
    // Remove tracking params — keep functional params only
    $tracking = array('utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'fbclid', 'gclid', 'gclsrc', 'msclkid', 'dclid', 'wbraid', 'gbraid',
        'mc_cid', 'mc_eid', 'ref', '_ga', 'hsa_acc', 'hsa_cam', 'hsa_grp',
        'hsa_ad', 'hsa_src', 'hsa_net', 'hsa_ver', 'hsa_la', 'hsa_ol', 'hsa_mt', 'hsa_kw', 'hsa_tgt');
    parse_str($query, $params);
    foreach ($tracking as $t) unset($params[$t]);
    if (empty($params)) return $path;
    return $path . '?' . http_build_query($params);
}

// Cache path helper — directory-based so Apache mod_rewrite can serve directly
function sropt_page_cache_path() {
    $clean_uri = sropt_clean_uri($_SERVER['REQUEST_URI']);
    $path = parse_url($clean_uri, PHP_URL_PATH);
    $host = preg_replace('/[^a-zA-Z0-9._-]/', '', $_SERVER['HTTP_HOST'] ?? 'default');
    // Convert /path/to/page/ into /path/to/page/_index.html
    $safe_path = rtrim($path, '/');
    if (empty($safe_path)) $safe_path = '';
    $dir = WP_CONTENT_DIR . '/cache/seoroom/pages/' . $host . $safe_path . '/';
    if (!file_exists($dir)) wp_mkdir_p($dir);
    return $dir . '_index.html';
}

// After the output buffer processes HTML, save to page cache
add_action('shutdown', 'sropt_page_cache_save', 999);
function sropt_page_cache_save() {
    if (is_admin() || is_user_logged_in()) return;
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') return;
    if (defined('DOING_CRON') && DOING_CRON) return;
    if (defined('XMLRPC_REQUEST') && XMLRPC_REQUEST) return;

    $options = sropt_get_options();
    if (!$options['enable_page_cache'] || $options['safe_mode']) return;

    // Skip if already served from cache
    $headers = headers_list();
    foreach ($headers as $h) {
        if (stripos($h, 'X-SEORoom-Cache: HIT') !== false) return;
    }

    $request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $excludes = array_filter(array_map('trim', explode(',', $options['cache_exclude_urls'])));
    foreach ($excludes as $exc) {
        if ($exc && strpos($request_uri, $exc) !== false) return;
    }
    $never_cache = array('/wp-admin', '/wp-login', '/cart', '/checkout', '/my-account', '/wp-json', '/feed', '/wp-cron', '/xmlrpc');
    foreach ($never_cache as $nc) {
        if (strpos($request_uri, $nc) !== false) return;
    }

    // Skip non-200 responses
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
    // Don't cache pages with no-cache headers
    foreach ($headers as $h) {
        if (stripos($h, 'no-cache') !== false || stripos($h, 'no-store') !== false) return;
    }

    $content .= "\n<!-- Cached by SEO Room v" . SEOROOM_VERSION . " at " . gmdate('Y-m-d H:i:s') . " UTC -->";
    @file_put_contents($cache_file, $content);
}

// Serve cached page early (fallback if .htaccess rewrite isn't available — e.g. Nginx)
add_action('template_redirect', 'sropt_page_cache_serve_fallback', 0);
function sropt_page_cache_serve_fallback() {
    if (is_admin() || is_feed() || wp_doing_ajax()) return;
    if (defined('DOING_CRON') && DOING_CRON) return;
    if (is_user_logged_in()) return;
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') return;

    $options = sropt_get_options();
    if (!$options['enable_page_cache'] || $options['safe_mode']) return;

    $request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
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

// Clear page cache when content is updated
add_action('save_post', 'sropt_clear_page_cache', 10, 1);
add_action('comment_post', 'sropt_clear_page_cache');
add_action('transition_comment_status', 'sropt_clear_page_cache');
function sropt_clear_page_cache($post_id = 0) {
    $base_dir = WP_CONTENT_DIR . '/cache/seoroom/pages/';
    if (!file_exists($base_dir)) return;

    if ($post_id && is_numeric($post_id)) {
        $host = preg_replace('/[^a-zA-Z0-9._-]/', '', parse_url(home_url(), PHP_URL_HOST));
        // Clear specific page cache
        $url = get_permalink($post_id);
        if ($url) {
            $uri = rtrim(parse_url($url, PHP_URL_PATH), '/');
            $cache_file = $base_dir . $host . $uri . '/_index.html';
            if (file_exists($cache_file)) @unlink($cache_file);
        }
        // Also clear homepage
        $home_file = $base_dir . $host . '/_index.html';
        if (file_exists($home_file)) @unlink($home_file);
    } else {
        // Clear all page cache (recursive)
        $iter = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($base_dir, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($iter as $item) {
            if ($item->isFile() && $item->getExtension() === 'html') @unlink($item->getPathname());
        }
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
            $type = intval($request->get_param('redirect_type') ?: 301);
            $target = $type === 410 ? '' : trim($request->get_param('target_url'));
            if (empty($source) || ($type !== 410 && empty($target))) {
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
            $type = intval($request->get_param('redirect_type') ?: 301);
            $target = $type === 410 ? '' : trim($request->get_param('target_url') ?: '/');
            // Normalize source to PATH only — the serving side (sropt_check_redirects) matches on
            // md5(parse_url(REQUEST_URI, PATH)). Hashing the full URL here meant redirects never matched.
            $source_path = parse_url($row404->url, PHP_URL_PATH);
            if (empty($source_path)) $source_path = $row404->url;
            $hash = md5($source_path);
            $wpdb->query($wpdb->prepare(
                "INSERT INTO $tred (source_url, source_hash, target_url, redirect_type) VALUES (%s, %s, %s, %d)
                 ON DUPLICATE KEY UPDATE target_url=%s, redirect_type=%d, updated_at=NOW()",
                $source_path, $hash, $target, $type, $target, $type
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

    // ---- Security Headers: set / clear the headers the plugin emits via send_headers ----
    register_rest_route('seoroom-opt/v1', '/security-headers', array(
        'methods'  => 'POST',
        'callback' => 'seoroom_set_security_headers',
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));
    register_rest_route('seoroom-opt/v1', '/security-headers', array(
        'methods'  => 'GET',
        'callback' => function() { return new WP_REST_Response(array('headers' => get_option('seoroom_security_headers', array())), 200); },
        'permission_callback' => function() { return current_user_can('manage_options'); },
    ));
});

/**
 * Save the security headers the plugin should emit. Accepts either:
 *  - an explicit { headers: { x_frame_options: "...", ... } } object, OR
 *  - a list { headers: ["x-frame-options", ...] } of header keys to enable with safe defaults.
 * Pass { clear: true } to remove all headers. Returns the stored map.
 */
function seoroom_set_security_headers($request) {
    $body = $request->get_json_params();
    if (!empty($body['clear'])) {
        delete_option('seoroom_security_headers');
        return new WP_REST_Response(array('ok' => true, 'cleared' => true), 200);
    }
    // Safe defaults — CSP intentionally report-only, HSTS short max-age until HTTPS is proven
    $defaults = array(
        'x-frame-options'           => array('x_frame_options' => 'SAMEORIGIN'),
        'x-content-type-options'    => array('x_content_type_options' => 'nosniff'),
        'referrer-policy'           => array('referrer_policy' => 'strict-origin-when-cross-origin'),
        'permissions-policy'        => array('permissions_policy' => 'camera=(), microphone=(), geolocation=()'),
        'strict-transport-security' => array('strict_transport_security' => 'max-age=300'),
        'content-security-policy'   => array('csp_report_only' => "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'"),
    );
    $stored = get_option('seoroom_security_headers', array());
    if (!is_array($stored)) $stored = array();

    $in = isset($body['headers']) ? $body['headers'] : array();
    if (is_array($in) && array_keys($in) !== range(0, count($in) - 1)) {
        // Associative object: merge explicit values directly
        $stored = array_merge($stored, $in);
    } else {
        // List of header keys: apply safe defaults for each
        foreach ((array)$in as $key) {
            $key = strtolower(trim($key));
            if (isset($defaults[$key])) $stored = array_merge($stored, $defaults[$key]);
        }
    }
    update_option('seoroom_security_headers', $stored);
    return new WP_REST_Response(array('ok' => true, 'headers' => $stored), 200);
}

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

        // Render content (Elementor-aware) to get the REAL visible text + links — page-builder pages
        // keep nothing useful in post_content, so use Elementor's renderer when the page is built with it.
        $content = '';
        if (class_exists('\Elementor\Plugin') && isset(\Elementor\Plugin::$instance->db)
            && method_exists(\Elementor\Plugin::$instance->db, 'is_built_with_elementor')
            && \Elementor\Plugin::$instance->db->is_built_with_elementor($post->ID)) {
            $content = \Elementor\Plugin::$instance->frontend->get_builder_content_for_display($post->ID);
        }
        if (empty($content)) {
            $content = apply_filters('the_content', $post->post_content);
        }
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

        // Internal/external links — also collect the internal link list (href + anchor) for the internal-link audit
        $internal_links = 0;
        $external_links = 0;
        $internal_link_list = array();
        if (preg_match_all('/<a\s[^>]*href=["\']([^"\'#]+)["\'][^>]*>(.*?)<\/a>/is', $content, $a_matches, PREG_SET_ORDER)) {
            foreach ($a_matches as $am) {
                $href = $am[1];
                $anchor = trim(wp_strip_all_tags($am[2]));
                if (strpos($href, 'mailto:') === 0 || strpos($href, 'tel:') === 0) continue;
                if (strpos($href, $domain) !== false || strpos($href, '/') === 0) {
                    $internal_links++;
                    if ($anchor !== '' && strlen($anchor) <= 200 && count($internal_link_list) < 100) {
                        $internal_link_list[] = array('href' => $href, 'anchor' => $anchor);
                    }
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
            'type'             => $post->post_type, // 'page' or 'post'
            'id'               => $post->ID,
            'slug'             => $post->post_name,
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
            'text'             => function_exists('mb_substr') ? mb_substr($text, 0, 12000) : substr($text, 0, 12000),
            'links'            => $internal_link_list,
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
    // Match regardless of trailing slash — a redirect may have been stored with or without it.
    $alt_path = (substr($request_path, -1) === '/') ? rtrim($request_path, '/') : $request_path . '/';
    $hashes = array(md5($request_path));
    if ($alt_path !== '' && $alt_path !== $request_path) $hashes[] = md5($alt_path);
    $placeholders = implode(',', array_fill(0, count($hashes), '%s'));

    $redirect = $wpdb->get_row($wpdb->prepare(
        "SELECT * FROM $table WHERE source_hash IN ($placeholders) LIMIT 1", $hashes
    ));

    if ($redirect) {
        // Increment hit count
        $wpdb->query($wpdb->prepare(
            "UPDATE $table SET hit_count = hit_count + 1 WHERE id = %d", $redirect->id
        ));
        $rtype = intval($redirect->redirect_type);
        if ($rtype === 410) {
            // 410 Gone — tell search engines this page is permanently removed
            status_header(410);
            nocache_headers();
            echo '<!DOCTYPE html><html><head><title>410 Gone</title></head><body><h1>410 Gone</h1><p>This page has been permanently removed.</p></body></html>';
            exit;
        }
        wp_redirect($redirect->target_url, $rtype);
        exit;
    }
}

// One-time repair: redirects created from 404s in older versions stored source_hash = md5(full URL),
// but serving matches md5(path) — so they never fired. Recompute hash from the path for those rows.
add_action('admin_init', 'sropt_fix_redirect_hashes_once');
function sropt_fix_redirect_hashes_once() {
    if (get_option('sropt_redirect_hash_fixed_v2')) return;
    global $wpdb;
    $table = $wpdb->prefix . 'seoroom_redirects';
    if ($wpdb->get_var("SHOW TABLES LIKE '$table'") !== $table) { return; }
    $rows = $wpdb->get_results("SELECT id, source_url FROM $table WHERE source_url LIKE 'http%'");
    if ($rows) {
        foreach ($rows as $r) {
            $p = parse_url($r->source_url, PHP_URL_PATH);
            if (!empty($p)) {
                $wpdb->query($wpdb->prepare(
                    "UPDATE $table SET source_url=%s, source_hash=%s WHERE id=%d", $p, md5($p), $r->id
                ));
            }
        }
    }
    update_option('sropt_redirect_hash_fixed_v2', 1);
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
    if ($wpdb->get_var("SHOW TABLES LIKE '$table'") !== $table) return;

    $url = $_SERVER['REQUEST_URI'];
    $url_lower = strtolower($url);
    $url_path = strtok($url_lower, '?');

    // ---- STRICT FILTER: only log real page-like URLs ----
    // Skip anything with a file extension (images, scripts, styles, media, cache files, etc.)
    if (preg_match('/\.\w{1,10}$/', $url_path)) return;
    // Skip WordPress internals
    $skip_prefixes = array('/wp-login', '/wp-admin', '/wp-includes/', '/wp-content/', '/wp-json/', '/wp-cron', '/xmlrpc', '/feed/', '/trackback/');
    foreach ($skip_prefixes as $prefix) {
        if (strpos($url_lower, $prefix) !== false) return;
    }
    // Skip dotfiles, admin paths, scanner probes
    if (preg_match('#/\.|/admin|/cgi-bin|/phpmyadmin|/vendor/|/node_modules/#i', $url_lower)) return;
    // Skip URLs with protocol-like prefixes used as paths (e.g. /tel:, /mailto:)
    if (preg_match('#^/(tel|mailto|javascript|data):#i', $url_path)) return;
    // Skip suspicious query strings
    if (preg_match('/[<>\{\}]|eval\(|base64|SELECT\s|UNION\s|DROP\s/i', $url)) return;
    // ---- END FILTER ----

    $referrer = $_SERVER['HTTP_REFERER'] ?? '';
    $ua = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 512);

    // ---- AUTO-REDIRECT: try to match to an existing page ----
    $matched_url = sropt_find_matching_page($url_path);
    if ($matched_url) {
        // Auto-create a 301 redirect
        $red_table = $wpdb->prefix . 'seoroom_redirects';
        $source_path = parse_url($url, PHP_URL_PATH);
        $source_hash = md5($source_path);
        // Only create if redirect doesn't already exist
        $exists = $wpdb->get_var($wpdb->prepare("SELECT id FROM $red_table WHERE source_hash = %s", $source_hash));
        if (!$exists) {
            $wpdb->insert($red_table, array(
                'source_url'    => $source_path,
                'source_hash'   => $source_hash,
                'target_url'    => $matched_url,
                'redirect_type' => 301,
                'hit_count'     => 0,
                'created_at'    => current_time('mysql'),
                'updated_at'    => current_time('mysql'),
            ));
        }
        // Redirect immediately
        wp_redirect($matched_url, 301);
        exit;
    }

    // No match found — log the 404 for manual review
    $hash = md5($url);
    $wpdb->query($wpdb->prepare(
        "INSERT INTO $table (url, url_hash, referrer, user_agent, hit_count, first_seen, last_seen)
         VALUES (%s, %s, %s, %s, 1, NOW(), NOW())
         ON DUPLICATE KEY UPDATE hit_count = hit_count + 1, last_seen = NOW(), referrer = IF(%s != '', %s, referrer)",
        $url, $hash, $referrer, $ua, $referrer, $referrer
    ));
}

/**
 * Find a matching published page/post for a 404 URL using slug similarity.
 * Returns the matched permalink or false.
 */
function sropt_find_matching_page($url_path) {
    global $wpdb;

    // Extract slug parts from the 404 URL
    $path = trim($url_path, '/');
    if (empty($path)) return false;

    $segments = explode('/', $path);
    $last_slug = end($segments);  // Most specific part (e.g., "seo-audit-perth")
    $slug_words = explode('-', $last_slug);
    if (count($slug_words) < 1) return false;

    // Strategy 1: Exact slug match (handles moved pages, e.g., /old-parent/page-slug → /page-slug)
    $exact = $wpdb->get_row($wpdb->prepare(
        "SELECT ID, post_name, post_type FROM {$wpdb->posts}
         WHERE post_name = %s AND post_status = 'publish' AND post_type IN ('page', 'post')
         LIMIT 1",
        $last_slug
    ));
    if ($exact) {
        return get_permalink($exact->ID);
    }

    // Strategy 2: Partial slug match — find pages containing the key words
    // Build a LIKE query for pages whose slug shares words with the 404 slug
    // Only try if slug has 2+ words (avoid matching single common words like "services")
    if (count($slug_words) >= 2) {
        $like_clauses = array();
        $like_values = array();
        foreach ($slug_words as $word) {
            if (strlen($word) < 3) continue;  // Skip short words (and, the, of, etc.)
            $like_clauses[] = "post_name LIKE %s";
            $like_values[] = '%' . $wpdb->esc_like($word) . '%';
        }
        if (count($like_clauses) >= 2) {
            $sql = "SELECT ID, post_name FROM {$wpdb->posts}
                    WHERE post_status = 'publish' AND post_type IN ('page', 'post')
                    AND " . implode(' AND ', $like_clauses) . "
                    LIMIT 5";
            $candidates = $wpdb->get_results($wpdb->prepare($sql, ...$like_values));
            if ($candidates && count($candidates) === 1) {
                // Only auto-redirect if there's exactly one confident match
                return get_permalink($candidates[0]->ID);
            }
            // If multiple matches, pick the one with highest slug similarity
            if ($candidates && count($candidates) > 1) {
                $best = null;
                $best_score = 0;
                foreach ($candidates as $c) {
                    similar_text($last_slug, $c->post_name, $score);
                    if ($score > $best_score) {
                        $best_score = $score;
                        $best = $c;
                    }
                }
                if ($best && $best_score >= 60) {
                    return get_permalink($best->ID);
                }
            }
        }
    }

    // Strategy 3: For parent/child URL structures, try matching the full path
    if (count($segments) > 1) {
        $full_slug = implode('/', $segments);
        $page = get_page_by_path($full_slug, OBJECT, array('page', 'post'));
        if ($page && $page->post_status === 'publish') {
            return get_permalink($page->ID);
        }
    }

    return false;
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

            // Skip mailto, tel, javascript, and malformed URLs
            if (preg_match('/^(mailto:|tel:|javascript:)/i', $href)) continue;
            if (preg_match('/^https?:\/\/?$/i', $href)) continue; // bare https:// with no host

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


// ================================================================
// AUTO-UPDATE — Check Railway server for new versions
// ================================================================

// Fetch the latest version info from the dashboard, cached for 1 hour to avoid an HTTP call on every admin page load
function sropt_get_remote_update($force = false) {
    if (!$force) {
        $cached = get_transient('sropt_remote_update');
        if ($cached !== false) return $cached ?: null;
    }
    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'] ?? '', '/');
    if (empty($dashboard_url)) return null;

    $response = wp_remote_get($dashboard_url . '/api/plugin/update-check', array(
        'timeout' => 12,
        'headers' => array('Accept' => 'application/json'),
    ));
    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) return null;

    $data = json_decode(wp_remote_retrieve_body($response));
    if (!$data || !isset($data->version)) return null;

    // Cache for an hour (store empty string on miss so we don't hammer the endpoint)
    set_transient('sropt_remote_update', $data, HOUR_IN_SECONDS);
    return $data;
}

// Apply our update info to the plugins-update transient (shared by both the SET and READ hooks)
function sropt_apply_update($transient, $force = false) {
    $data = sropt_get_remote_update($force);
    if (!$data || !isset($data->version)) return $transient;

    $plugin_file   = plugin_basename(__FILE__);
    $dashboard_url = rtrim((sropt_get_options()['dashboard_url'] ?? ''), '/');

    if (version_compare(SEOROOM_VERSION, $data->version, '<')) {
        // We HAVE an update — attach it even if WordPress's transient is empty/false
        // (the previous bug: we bailed when $transient wasn't an object, so the update never showed
        //  on sites where WP couldn't refresh the list from wp.org)
        if (!is_object($transient)) $transient = new stdClass();
        if (!isset($transient->response) || !is_array($transient->response)) $transient->response = array();
        $transient->response[$plugin_file] = (object) array(
            'slug'        => $data->slug ?? 'seoroom',
            'plugin'      => $plugin_file,
            'new_version' => $data->version,
            'url'         => $dashboard_url,
            'package'     => $data->download_url,
            'requires'    => $data->requires ?? '5.8',
            'tested'      => $data->tested ?? '6.7',
        );
        if (isset($transient->no_update[$plugin_file])) unset($transient->no_update[$plugin_file]);
    } else if (is_object($transient)) {
        // No update available — only annotate an existing real transient; don't fabricate one
        if (!isset($transient->no_update) || !is_array($transient->no_update)) $transient->no_update = array();
        $transient->no_update[$plugin_file] = (object) array(
            'slug'        => $data->slug ?? 'seoroom',
            'plugin'      => $plugin_file,
            'new_version' => SEOROOM_VERSION,
            'url'         => $dashboard_url,
        );
    }
    return $transient;
}

// SET hook — fires on WP's own update check (force a fresh remote read here). High priority so we win over ManageWP/other update managers.
add_filter('pre_set_site_transient_update_plugins', 'sropt_check_for_update', 999999);
function sropt_check_for_update($transient) {
    if (empty($transient->checked)) return $transient;
    return sropt_apply_update($transient, true);
}

// READ hook — fires on every read of the transient (Plugins/Updates page loads). High priority to run last.
add_filter('site_transient_update_plugins', 'sropt_read_update', 999999);
function sropt_read_update($transient) {
    global $pagenow;
    // On the screens that actually display updates, bypass our cache and fetch live —
    // a persistent object cache can otherwise serve a stale "no update" result forever
    $live = in_array($pagenow, array('plugins.php', 'update-core.php', 'update.php'), true);
    return sropt_apply_update($transient, $live);
}

// Force a genuine, cache-bypassing re-check whenever the admin opens Plugins / Updates / SEO Room settings
function sropt_force_update_refresh() {
    delete_transient('sropt_remote_update');
    sropt_get_remote_update(true);            // live fetch now (force), repopulates cache
    delete_site_transient('update_plugins');  // make WP rebuild its list (fires our SET hook too)
}
add_action('load-plugins.php', 'sropt_force_update_refresh');
add_action('load-update-core.php', 'sropt_force_update_refresh');
add_action('load-update.php', 'sropt_force_update_refresh');
add_action('admin_init', function () {
    if (isset($_GET['page']) && $_GET['page'] === 'seoroom') sropt_force_update_refresh();
});
register_activation_hook(__FILE__, 'sropt_force_update_refresh');

// Back-compat alias
function sropt_clear_update_cache() { sropt_force_update_refresh(); }

// ================================================================
// INTERNAL LINK INJECTOR
// Pulls approved internal links from the dashboard (outbound — never IP-blocked) and injects them at
// RENDER TIME via the_content. Wraps the first matching anchor phrase on each page in a real <a> link.
// Works on Elementor / Gutenberg / classic because it acts on the final rendered HTML, not post_content.
// Fully reversible: nothing in the database is changed — deactivate the plugin or clear the links and it's gone.
// ================================================================
function sropt_get_internal_links($force = false) {
    if (!$force) {
        $cached = get_transient('sropt_internal_links');
        if ($cached !== false) return is_array($cached) ? $cached : array();
    }
    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'] ?? '', '/');
    $project_id = $options['project_id'] ?? '';
    if (empty($dashboard_url) || empty($project_id)) { set_transient('sropt_internal_links', array(), HOUR_IN_SECONDS); return array(); }

    $resp = wp_remote_get($dashboard_url . '/api/projects/' . intval($project_id) . '/internal-links/approved', array(
        'timeout' => 12,
        'headers' => array('Accept' => 'application/json'),
    ));
    if (is_wp_error($resp) || wp_remote_retrieve_response_code($resp) !== 200) {
        set_transient('sropt_internal_links', array(), 15 * MINUTE_IN_SECONDS);
        return array();
    }
    $data = json_decode(wp_remote_retrieve_body($resp), true);
    $links = (is_array($data) && isset($data['links_by_page']) && is_array($data['links_by_page'])) ? $data['links_by_page'] : array();
    set_transient('sropt_internal_links', $links, HOUR_IN_SECONDS);

    // Auto-flush page caches when the approved-link set actually changes, so injected links
    // go live without anyone manually clearing BerqWP. Signature compare avoids redundant purges.
    $sig = md5(wp_json_encode($links));
    $prev_sig = get_option('sropt_links_sig', '');
    if ($sig !== $prev_sig) {
        update_option('sropt_links_sig', $sig);
        if ($prev_sig !== '') { // skip the very first population
            $prev_pages = get_option('sropt_links_pages', array());
            $now_pages = array_keys($links);
            $affected = array_values(array_unique(array_merge(is_array($prev_pages) ? $prev_pages : array(), $now_pages)));
            sropt_flush_caches($affected);
        }
        update_option('sropt_links_pages', array_keys($links));
    }
    return $links;
}

// Purge page caches automatically so newly injected/removed links go live with no manual flush.
// Targets specific URLs when given (via clean_post_cache, which BerqWP and most caches bind to),
// and fires the site-wide purge of every major cache layer it can find.
function sropt_flush_caches($urls = null) {
    if (is_array($urls) && !empty($urls)) {
        foreach ($urls as $u) {
            $pid = url_to_postid($u);
            if ($pid) {
                clean_post_cache($pid);                 // fires `clean_post_cache` — BerqWP & most caches recache the page
                do_action('clean_post_cache', $pid, get_post($pid));
            }
        }
    }
    // BerqWP — call any public clear function it exposes, then fire its action hooks.
    foreach (array('berqwp_clear_cache', 'bwp_clear_cache', 'berqwp_clear_all_cache', 'bwp_purge_all', 'berqwp_purge_everything') as $fn) {
        if (function_exists($fn)) { @call_user_func($fn); }
    }
    do_action('berqwp_clear_cache');
    do_action('berqwp/clear_cache');
    // Other common cache plugins (guarded so we only call what's installed).
    if (function_exists('rocket_clean_domain'))  rocket_clean_domain();        // WP Rocket
    if (function_exists('w3tc_flush_all'))        w3tc_flush_all();            // W3 Total Cache
    if (function_exists('wp_cache_clear_cache'))  wp_cache_clear_cache();      // WP Super Cache
    if (function_exists('wpfc_clear_all_cache'))  wpfc_clear_all_cache();      // WP Fastest Cache
    if (class_exists('autoptimizeCache') && method_exists('autoptimizeCache', 'clearall')) autoptimizeCache::clearall();
    // LiteSpeed + Cloudflare (BerqWP integrates these) + generic object cache.
    do_action('litespeed_purge_all');
    do_action('cloudflare_purge_everything');
    if (function_exists('wp_cache_flush')) wp_cache_flush();
}

// Inject internal links by output-buffering the WHOLE rendered page. This catches Elementor / any page
// builder, because it acts on the final HTML — unlike the_content, which Elementor renders around.
add_action('template_redirect', 'sropt_il_buffer_start', 1);
function sropt_il_buffer_start() {
    if (is_admin() || !is_singular()) return;
    // Never run during a copywriter Design-Safe Preview — its own output buffer handles the page, and link
    // injection would collide with section-preview.js's content matching.
    if (!empty($_GET['seoroom_preview']) || !empty($_GET['elementor-preview']) || (function_exists('is_preview') && is_preview())) return;

    $links_by_page = sropt_get_internal_links();
    if (empty($links_by_page)) return;

    $perma = rtrim((string) get_permalink(), '/');
    $links = isset($links_by_page[$perma]) ? $links_by_page[$perma] : null;
    if (empty($links)) {
        $alt = rtrim(home_url(parse_url($perma, PHP_URL_PATH) ?: ''), '/');
        if (isset($links_by_page[$alt])) $links = $links_by_page[$alt];
    }
    if (empty($links)) return;

    ob_start(function ($html) use ($links) {
        if (empty($html) || strlen($html) < 500) return $html;
        // Only operate on the <body> so we never touch <head>; the first-occurrence logic skips text already in <a>.
        $pos = stripos($html, '<body');
        if ($pos === false) return $html;
        $head = substr($html, 0, $pos);
        $body = substr($html, $pos);
        foreach ($links as $link) {
            $anchor = isset($link['anchor']) ? trim($link['anchor']) : '';
            $target = isset($link['target']) ? trim($link['target']) : '';
            if ($anchor === '' || $target === '') continue;
            $body = sropt_link_first_occurrence($body, $anchor, $target);
        }
        return $head . $body;
    });
}

// Wrap the first occurrence of $anchor that is NOT already inside an <a> tag.
function sropt_link_first_occurrence($html, $anchor, $target) {
    $parts = preg_split('/(<[^>]+>)/', $html, -1, PREG_SPLIT_DELIM_CAPTURE);
    if (!is_array($parts)) return $html;
    $in_anchor = false;
    $heading_depth = 0;
    $done = false;
    // Whitespace/entity-flexible: a space in the anchor matches any run of whitespace or &nbsp; in the
    // rendered HTML, so anchors still place across line breaks, double spaces, or non-breaking spaces.
    $quoted = preg_quote($anchor, '/');
    $quoted = preg_replace('/\s+/', '(?:\\\\s|&nbsp;|&#160;)+', $quoted);
    foreach ($parts as $i => $part) {
        if ($done) break;
        if ($part !== '' && $part[0] === '<') {
            if (preg_match('/^<a[\s>]/i', $part)) $in_anchor = true;
            elseif (preg_match('/^<\/a>/i', $part)) $in_anchor = false;
            // Never place links inside headings (h1-h6) — anchors must live in body text only.
            elseif (preg_match('/^<h[1-6][\s>]/i', $part)) $heading_depth++;
            elseif (preg_match('/^<\/h[1-6]>/i', $part) && $heading_depth > 0) $heading_depth--;
            continue;
        }
        if ($in_anchor || $heading_depth > 0 || $part === '') continue;
        if (preg_match('/' . $quoted . '/i', $part, $m, PREG_OFFSET_CAPTURE)) {
            $pos = $m[0][1];
            $matched = $m[0][0];
            // $matched is the page's own rendered text (may contain entities like &nbsp;) — output as-is, do NOT re-escape
            $parts[$i] = substr($part, 0, $pos)
                . '<a href="' . esc_url($target) . '" class="seoroom-internal-link">' . $matched . '</a>'
                . substr($part, $pos + strlen($matched));
            $done = true;
        }
    }
    return $done ? implode('', $parts) : $html;
}

// Refresh the cached links when the admin opens SEO Room settings (so approvals show fast)
add_action('admin_init', function () {
    if (isset($_GET['page']) && $_GET['page'] === 'seoroom') {
        delete_transient('sropt_internal_links');
        // Confirm live status shortly after, once the fresh links are loaded
        if (!wp_next_scheduled('sropt_confirm_links_event')) wp_schedule_single_event(time() + 30, 'sropt_confirm_links_event');
    }
});

// Confirm to the dashboard which approved links are ACTUALLY on the live pages.
// Fetches each page through the full WordPress+builder pipeline and looks for our injected <a> — so the
// dashboard can show "Live" only when the link is genuinely placed (and "Can't place" when it isn't).
add_action('sropt_confirm_links_event', 'sropt_confirm_internal_links');
function sropt_confirm_internal_links() {
    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'] ?? '', '/');
    $project_id = $options['project_id'] ?? '';
    if (empty($dashboard_url) || empty($project_id)) return;

    $links_by_page = sropt_get_internal_links(true);
    if (empty($links_by_page)) return;

    $confirmations = array();
    foreach ($links_by_page as $page_url => $links) {
        // Cache-bypass: a unique query string + no-cache headers force BerqWP/Cloudflare to serve a FRESH
        // PHP render, so the render-time link injector actually runs and we see the real placed links.
        $bust = (strpos($page_url, '?') === false ? '?' : '&') . 'seoroom_verify=' . time();
        $resp = wp_remote_get($page_url . $bust, array(
            'timeout' => 20,
            'headers' => array(
                'User-Agent'    => 'SEORoomBot/1.0',
                'Cache-Control' => 'no-cache, no-store, max-age=0',
                'Pragma'        => 'no-cache',
            ),
        ));
        $html = is_wp_error($resp) ? '' : wp_remote_retrieve_body($resp);
        // Collect hrefs of OUR injected links on this page
        $injected = array();
        if ($html) {
            if (preg_match_all('/<a\s[^>]*class="[^"]*seoroom-internal-link[^"]*"[^>]*href="([^"]+)"/i', $html, $m1)) $injected = array_merge($injected, $m1[1]);
            if (preg_match_all('/<a\s[^>]*href="([^"]+)"[^>]*class="[^"]*seoroom-internal-link[^"]*"/i', $html, $m2)) $injected = array_merge($injected, $m2[1]);
        }
        foreach ($links as $link) {
            $target = $link['target'] ?? '';
            $tpath = parse_url($target, PHP_URL_PATH);
            $live = false;
            foreach ($injected as $h) {
                if (($target && strpos($h, $target) !== false) || ($tpath && strpos($h, $tpath) !== false)) { $live = true; break; }
            }
            $confirmations[] = array('source_url' => $page_url, 'target_url' => $target, 'live' => $live);
        }
    }
    if (empty($confirmations)) return;
    wp_remote_post($dashboard_url . '/api/projects/' . intval($project_id) . '/internal-links/confirm', array(
        'timeout' => 25,
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => wp_json_encode(array('confirmations' => $confirmations)),
    ));
}
add_action('init', function () {
    if (!wp_next_scheduled('sropt_confirm_links_event')) wp_schedule_event(time() + 600, 'hourly', 'sropt_confirm_links_event');
});
register_deactivation_hook(__FILE__, function () {
    $ts = wp_next_scheduled('sropt_confirm_links_event');
    if ($ts) wp_unschedule_event($ts, 'sropt_confirm_links_event');
});

// ================================================================
// SELF-CONTAINED ONE-CLICK UPDATER
// Shows an "Update now" button on the SEO Room settings page and installs the
// latest build directly from the dashboard — independent of WordPress's plugin
// update list (which ManageWP / object caches can suppress on this site).
// ================================================================
add_action('admin_notices', 'sropt_self_update_notice');
function sropt_self_update_notice() {
    if (($_GET['page'] ?? '') !== 'seoroom' || !current_user_can('update_plugins')) return;

    if (isset($_GET['sropt_updated'])) {
        $f = $_GET['sropt_updated'];
        $cls = $f === '1' ? 'success' : ($f === 'current' ? 'info' : 'error');
        $msg = $f === '1' ? 'SEO Room updated successfully to v' . esc_html(SEOROOM_VERSION) . '.'
             : ($f === 'current' ? 'SEO Room is already on the latest version (v' . esc_html(SEOROOM_VERSION) . ').'
             : 'SEO Room update failed: ' . esc_html($_GET['sropt_msg'] ?? 'unknown error'));
        echo '<div class="notice notice-' . $cls . ' is-dismissible"><p>' . $msg . '</p></div>';
    }

    $data = sropt_get_remote_update(true);
    if ($data && isset($data->version) && version_compare(SEOROOM_VERSION, $data->version, '<')) {
        $url = wp_nonce_url(admin_url('admin-post.php?action=sropt_self_update'), 'sropt_self_update');
        echo '<div class="notice notice-warning"><p style="font-size:14px;">'
            . '&#128640; <strong>SEO Room ' . esc_html($data->version) . '</strong> is available '
            . '(you have ' . esc_html(SEOROOM_VERSION) . '). '
            . '<a href="' . esc_url($url) . '" class="button button-primary" style="margin-left:8px;">Update now</a>'
            . '</p></div>';
    }
}

// Shared installer — used by both the manual button and the daily auto-update cron.
// Uses Plugin_Upgrader directly (works regardless of ManageWP / object cache hijacking WP's update list).
function sropt_perform_self_update() {
    $data = sropt_get_remote_update(true);
    if (!$data || empty($data->version) || empty($data->download_url)) {
        return array('ok' => false, 'msg' => 'No update info available', 'version' => null, 'updated' => false);
    }
    // Already up to date?
    if (!version_compare(SEOROOM_VERSION, $data->version, '<')) {
        return array('ok' => true, 'msg' => 'Already up to date', 'version' => SEOROOM_VERSION, 'updated' => false);
    }

    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/misc.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';

    $plugin_file = plugin_basename(__FILE__);
    $was_active  = is_plugin_active($plugin_file);

    $skin     = new WP_Ajax_Upgrader_Skin();
    $upgrader = new Plugin_Upgrader($skin);
    $result   = $upgrader->install($data->download_url, array('overwrite_package' => true));

    $ok  = ($result === true) || (!is_wp_error($result) && !$skin->get_errors()->has_errors());
    $msg = '';
    if (is_wp_error($result)) $msg = $result->get_error_message();
    elseif ($skin->get_errors()->has_errors()) $msg = implode('; ', (array) $skin->get_error_messages());

    if ($was_active && !is_plugin_active($plugin_file)) activate_plugin($plugin_file);
    sropt_force_update_refresh();
    // New plugin code can change how pages render — purge caches so the update is visible immediately.
    if ($ok && function_exists('sropt_flush_caches')) sropt_flush_caches();
    update_option('sropt_last_auto_update', array('time' => current_time('mysql'), 'ok' => $ok, 'to' => $data->version, 'msg' => $msg));

    return array('ok' => $ok, 'msg' => $msg, 'version' => $data->version, 'updated' => $ok);
}

// Manual "Update now" button
add_action('admin_post_sropt_self_update', 'sropt_handle_self_update');
function sropt_handle_self_update() {
    if (!current_user_can('update_plugins')) wp_die('You are not allowed to update plugins.');
    check_admin_referer('sropt_self_update');
    $r = sropt_perform_self_update();
    $flag = !empty($r['updated']) ? '1' : (!empty($r['ok']) ? 'current' : '0');
    wp_safe_redirect(add_query_arg(array('sropt_updated' => $flag, 'sropt_msg' => rawurlencode($r['msg'])), admin_url('options-general.php?page=seoroom')));
    exit;
}

// ── AUTO-UPDATE: install new versions automatically on a daily schedule ──
add_action('sropt_auto_update_event', 'sropt_cron_auto_update');
function sropt_cron_auto_update() {
    // Respect an opt-out switch if present
    $opts = sropt_get_options();
    if (isset($opts['auto_update']) && $opts['auto_update'] === false) return;
    sropt_perform_self_update();
}
// Ensure the daily event is scheduled
add_action('init', function () {
    if (!wp_next_scheduled('sropt_auto_update_event')) {
        wp_schedule_event(time() + 300, 'daily', 'sropt_auto_update_event');
    }
});
register_activation_hook(__FILE__, function () {
    if (!wp_next_scheduled('sropt_auto_update_event')) {
        wp_schedule_event(time() + 300, 'daily', 'sropt_auto_update_event');
    }
});
register_deactivation_hook(__FILE__, function () {
    $ts = wp_next_scheduled('sropt_auto_update_event');
    if ($ts) wp_unschedule_event($ts, 'sropt_auto_update_event');
});

// Plugin info popup (when user clicks "View details")
add_filter('plugins_api', 'sropt_plugin_info', 20, 3);
function sropt_plugin_info($result, $action, $args) {
    if ($action !== 'plugin_information' || ($args->slug ?? '') !== 'seoroom') return $result;

    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'], '/');
    if (empty($dashboard_url)) return $result;

    $response = wp_remote_get($dashboard_url . '/api/plugin/update-check', array('timeout' => 10));
    if (is_wp_error($response)) return $result;

    $data = json_decode(wp_remote_retrieve_body($response));
    if (!$data) return $result;

    return (object) array(
        'name'          => 'SEO Room',
        'slug'          => 'seoroom',
        'version'       => $data->version,
        'author'        => '<a href="https://theseoroom.com.au">The SEO Room</a>',
        'homepage'      => 'https://theseoroom.com.au',
        'download_link' => $data->download_url,
        'requires'      => $data->requires ?? '5.8',
        'tested'        => $data->tested ?? '6.7',
        'sections'      => array(
            'description' => 'SEO Room — Local SEO automation plugin. Schema, 404 monitor, redirects, speed optimizations, dashboard connector.',
            'changelog'   => $data->changelog ?? 'See dashboard for changelog.',
        ),
    );
}

// After update, clear transient so next check is fresh
add_action('upgrader_process_complete', 'sropt_after_update', 10, 2);
function sropt_after_update($upgrader, $options) {
    if ($options['action'] === 'update' && $options['type'] === 'plugin') {
        delete_site_transient('update_plugins');
    }
}


// ================================================================
// LICENSE SYSTEM — Yearly renewal, read-only on expire
// ================================================================

// AJAX handler for "Check License Now" button (server-side call, no CORS)
add_action('wp_ajax_sropt_ajax_check_license', 'sropt_ajax_check_license');
function sropt_ajax_check_license() {
    check_ajax_referer('sropt_license_nonce', 'nonce');

    $license_key = sanitize_text_field($_POST['license_key'] ?? '');
    if (empty($license_key)) {
        wp_send_json_error('No license key provided');
    }

    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'] ?? '', '/');
    if (empty($dashboard_url)) {
        wp_send_json_error('Dashboard URL not set');
    }

    // Clear cached status so we get fresh result
    delete_transient('sropt_license_status');

    $response = wp_remote_post($dashboard_url . '/api/plugin/license-check', array(
        'timeout' => 15,
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => json_encode(array(
            'license_key' => $license_key,
            'domain'      => home_url(),
        )),
    ));

    if (is_wp_error($response)) {
        wp_send_json_error('Connection failed: ' . $response->get_error_message());
    }

    $data = json_decode(wp_remote_retrieve_body($response), true);
    if (!$data) {
        wp_send_json_error('Invalid response from dashboard (HTTP ' . wp_remote_retrieve_response_code($response) . ')');
    }

    // Update stored license info
    if (!empty($data['valid'])) {
        set_transient('sropt_license_status', 'valid', DAY_IN_SECONDS);
    }
    update_option('sropt_license_info', array(
        'valid'          => !empty($data['valid']),
        'reason'         => $data['reason'] ?? '',
        'project_name'   => $data['project_name'] ?? '',
        'expires'        => $data['expires'] ?? '',
        'days_remaining' => $data['days_remaining'] ?? null,
        'checked_at'     => current_time('mysql'),
    ));

    wp_send_json_success($data);
}

// Check if license is valid (cached for 24 hours)
function sropt_is_license_valid() {
    $cached = get_transient('sropt_license_status');
    if ($cached !== false) return $cached === 'valid';

    $options = sropt_get_options();
    $dashboard_url = rtrim($options['dashboard_url'], '/');
    $license_key = $options['license_key'] ?? '';

    if (empty($dashboard_url) || empty($license_key)) {
        set_transient('sropt_license_status', 'no_key', DAY_IN_SECONDS);
        return false;
    }

    $response = wp_remote_post($dashboard_url . '/api/plugin/license-check', array(
        'timeout' => 10,
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => json_encode(array(
            'license_key' => $license_key,
            'domain'      => home_url(),
        )),
    ));

    if (is_wp_error($response)) {
        // Network error — grace period, assume valid
        set_transient('sropt_license_status', 'valid', HOUR_IN_SECONDS);
        return true;
    }

    $data = json_decode(wp_remote_retrieve_body($response), true);
    $valid = !empty($data['valid']);

    set_transient('sropt_license_status', $valid ? 'valid' : 'expired', DAY_IN_SECONDS);

    // Store extra info for admin display
    if ($data) {
        update_option('sropt_license_info', array(
            'valid'          => $valid,
            'reason'         => $data['reason'] ?? '',
            'project_name'   => $data['project_name'] ?? '',
            'expires'        => $data['expires'] ?? '',
            'days_remaining' => $data['days_remaining'] ?? null,
            'checked_at'     => current_time('mysql'),
        ));
    }

    return $valid;
}

// Schedule daily license check via wp_cron
add_action('wp', 'sropt_schedule_license_check');
function sropt_schedule_license_check() {
    if (!wp_next_scheduled('sropt_daily_license_check')) {
        wp_schedule_event(time(), 'daily', 'sropt_daily_license_check');
    }
}
add_action('sropt_daily_license_check', 'sropt_run_license_check');
function sropt_run_license_check() {
    delete_transient('sropt_license_status');
    sropt_is_license_valid();
}

// Admin notice when license is expired
add_action('admin_notices', 'sropt_license_admin_notice');
function sropt_license_admin_notice() {
    $options = sropt_get_options();
    if (empty($options['license_key'])) return; // No key set yet, don't nag

    if (!sropt_is_license_valid()) {
        $info = get_option('sropt_license_info', array());
        $reason = $info['reason'] ?? 'expired';
        echo '<div class="notice notice-error"><p>';
        echo '<strong>SEO Room:</strong> License ' . esc_html($reason) . '. ';
        echo 'The plugin is in read-only mode — existing redirects and schema continue working, but management features are disabled. ';
        echo 'Contact <a href="https://theseoroom.com.au">The SEO Room</a> to renew.';
        echo '</p></div>';
    } else {
        $info = get_option('sropt_license_info', array());
        $days = $info['days_remaining'] ?? null;
        if ($days !== null && $days <= 30 && $days > 0) {
            echo '<div class="notice notice-warning"><p>';
            echo '<strong>SEO Room:</strong> License expires in ' . intval($days) . ' days. Contact The SEO Room to renew.';
            echo '</p></div>';
        }
    }
}

// Gate management features behind license check
// These functions return true if the feature should be BLOCKED
function sropt_is_management_blocked() {
    $options = sropt_get_options();
    if (empty($options['license_key'])) return false; // No license system yet, don't block
    return !sropt_is_license_valid();
}

// Block REST API management endpoints when license expired
add_filter('rest_pre_dispatch', 'sropt_license_gate_rest', 10, 3);
function sropt_license_gate_rest($result, $server, $request) {
    $route = $request->get_route();

    // Only gate seoroom management endpoints (not read-only ones)
    if (strpos($route, 'seoroom-opt/v1/') === false) return $result;

    // Allow read-only endpoints always
    $read_only_patterns = array('/status', '/update-check');
    foreach ($read_only_patterns as $p) {
        if (strpos($route, $p) !== false) return $result;
    }

    // Allow GET requests (reading data is always OK)
    if ($request->get_method() === 'GET') return $result;

    // Block write operations when license expired
    if (sropt_is_management_blocked()) {
        return new WP_Error(
            'license_expired',
            'SEO Room license expired. Management features are disabled. Existing redirects and schema continue working. Contact The SEO Room to renew.',
            array('status' => 403)
        );
    }

    return $result;
}
