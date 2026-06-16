<?php
/**
 * Plugin Name: SEO Room Reader
 * Description: API-key REST endpoints for the SEO Room dashboard on hosts that strip the Authorization header. Reads a page's full Elementor data, builds new Elementor pages with Yoast meta, and publishes drafts — all authenticated by an API key in the request (no Application Password needed).
 * Version: 1.1.0
 * Author: The SEO Room
 */

if (!defined('ABSPATH')) exit;

// API key — must match the key the dashboard uses for this site.
if (!defined('SEOROOM_READER_KEY')) {
    define('SEOROOM_READER_KEY', 'sr_2026_kX9mNpQ4wR7vBz');
}

add_action('rest_api_init', function () {
    $ns = 'seoroom-reader/v1';
    register_rest_route($ns, '/elementor/(?P<id>\d+)', array(
        'methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => 'seoroom_reader_get_elementor',
    ));
    register_rest_route($ns, '/resolve', array(
        'methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => 'seoroom_reader_resolve_slug',
    ));
    register_rest_route($ns, '/build-page', array(
        'methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'seoroom_reader_build_page',
    ));
    register_rest_route($ns, '/publish', array(
        'methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'seoroom_reader_publish',
    ));
});

function seoroom_reader_check_key($req) {
    $key = $req->get_param('api_key');
    return ($key && hash_equals(SEOROOM_READER_KEY, (string) $key));
}

function seoroom_reader_get_elementor($req) {
    if (!seoroom_reader_check_key($req)) return new WP_REST_Response(array('error' => 'invalid api_key'), 401);
    $id = intval($req['id']);
    $post = get_post($id);
    if (!$post) return new WP_REST_Response(array('error' => 'not found'), 404);
    $data = get_post_meta($id, '_elementor_data', true);
    $ps   = get_post_meta($id, '_elementor_page_settings', true);
    return new WP_REST_Response(array(
        'id' => $id, 'title' => get_the_title($id), 'slug' => $post->post_name,
        'edit_mode' => get_post_meta($id, '_elementor_edit_mode', true),
        'elementor_data' => is_string($data) ? $data : wp_json_encode($data),
        'page_settings'  => is_string($ps) ? $ps : wp_json_encode($ps),
    ), 200);
}

function seoroom_reader_resolve_slug($req) {
    if (!seoroom_reader_check_key($req)) return new WP_REST_Response(array('error' => 'invalid api_key'), 401);
    $slug = sanitize_title($req->get_param('slug'));
    if (!$slug) return new WP_REST_Response(array('error' => 'slug required'), 400);
    $page = get_page_by_path($slug, OBJECT, array('page', 'post'));
    if (!$page) {
        $q = get_posts(array('name' => $slug, 'post_type' => 'any', 'post_status' => 'any', 'numberposts' => 1));
        if (!empty($q)) $page = $q[0];
    }
    if (!$page) return new WP_REST_Response(array('error' => 'not found'), 404);
    return new WP_REST_Response(array('id' => $page->ID, 'slug' => $page->post_name, 'type' => $page->post_type), 200);
}

/**
 * Create (or update by slug) an Elementor page with Yoast meta.
 * Body: { api_key, title, slug, status, elementor_data (json string), yoast:{title,metadesc,focuskw} }
 */
function seoroom_reader_build_page($req) {
    if (!seoroom_reader_check_key($req)) return new WP_REST_Response(array('error' => 'invalid api_key'), 401);

    $title  = (string) $req->get_param('title');
    $slug   = sanitize_title($req->get_param('slug'));
    $status = $req->get_param('status');
    $status = in_array($status, array('publish', 'draft', 'pending', 'private'), true) ? $status : 'draft';
    $elementor = $req->get_param('elementor_data'); // JSON string
    $yoast  = $req->get_param('yoast');
    if (is_string($yoast)) { $decoded = json_decode($yoast, true); if (is_array($decoded)) $yoast = $decoded; }
    if (!is_array($yoast)) $yoast = array();
    if (!$slug && $title) $slug = sanitize_title($title);
    if (!$slug) return new WP_REST_Response(array('error' => 'slug or title required'), 400);

    // Reuse an existing page with the same slug if present, else create.
    $existing = get_page_by_path($slug, OBJECT, 'page');
    $postarr = array('post_title' => $title ?: $slug, 'post_name' => $slug, 'post_status' => $status, 'post_type' => 'page');
    if ($existing) { $postarr['ID'] = $existing->ID; $pid = wp_update_post($postarr, true); }
    else { $pid = wp_insert_post($postarr, true); }
    if (is_wp_error($pid)) return new WP_REST_Response(array('error' => $pid->get_error_message()), 500);

    // Elementor data — raw meta (proven to render correctly), with the empty-settings safety fix.
    if (is_string($elementor) && strlen($elementor) > 2) {
        $fixed = str_replace('"settings":[]', '"settings":{}', $elementor);
        update_post_meta($pid, '_elementor_data', wp_slash($fixed));
        update_post_meta($pid, '_elementor_edit_mode', 'builder');
        update_post_meta($pid, '_elementor_page_settings', array('hide_title' => 'yes'));
        update_post_meta($pid, '_wp_page_template', 'elementor_header_footer');
        if (get_post_meta($pid, '_elementor_version', true) === '') update_post_meta($pid, '_elementor_version', '3.0.0');
    }

    // Yoast meta
    if (!empty($yoast['title']))    update_post_meta($pid, '_yoast_wpseo_title', $yoast['title']);
    if (!empty($yoast['metadesc'])) update_post_meta($pid, '_yoast_wpseo_metadesc', $yoast['metadesc']);
    if (!empty($yoast['focuskw']))  update_post_meta($pid, '_yoast_wpseo_focuskw', $yoast['focuskw']);

    return new WP_REST_Response(array(
        'id' => $pid,
        'slug' => get_post_field('post_name', $pid),
        'status' => get_post_status($pid),
        'link' => get_permalink($pid),
        'edit_link' => admin_url('post.php?post=' . $pid . '&action=edit'),
        'reused' => $existing ? true : false,
    ), 200);
}

/** Body: { api_key, ids:[...] } → set status=publish */
function seoroom_reader_publish($req) {
    if (!seoroom_reader_check_key($req)) return new WP_REST_Response(array('error' => 'invalid api_key'), 401);
    $ids = $req->get_param('ids');
    if (!is_array($ids)) $ids = array();
    $published = array(); $errors = array();
    foreach ($ids as $id) {
        $id = intval($id);
        if (!$id) continue;
        $r = wp_update_post(array('ID' => $id, 'post_status' => 'publish'), true);
        if (is_wp_error($r)) $errors[] = array('id' => $id, 'error' => $r->get_error_message());
        else $published[] = $id;
    }
    return new WP_REST_Response(array('published' => $published, 'errors' => $errors), 200);
}
