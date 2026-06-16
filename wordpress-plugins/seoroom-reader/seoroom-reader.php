<?php
/**
 * Plugin Name: SEO Room Reader
 * Description: Read-only REST endpoint that returns a page's full Elementor data (_elementor_data), authenticated by an API key in the query string. Works on hosts that strip the Authorization header, so the SEO Room dashboard can read templates without Application Passwords.
 * Version: 1.0.0
 * Author: The SEO Room
 */

if (!defined('ABSPATH')) exit;

// API key — must match the key used by the dashboard for this site.
if (!defined('SEOROOM_READER_KEY')) {
    define('SEOROOM_READER_KEY', 'sr_2026_kX9mNpQ4wR7vBz');
}

add_action('rest_api_init', function () {
    register_rest_route('seoroom-reader/v1', '/elementor/(?P<id>\d+)', array(
        'methods'             => 'GET',
        'permission_callback' => '__return_true', // key is checked inside
        'callback'            => 'seoroom_reader_get_elementor',
    ));
    // Resolve a page ID from a slug (handy when the public REST hides drafts/private)
    register_rest_route('seoroom-reader/v1', '/resolve', array(
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => 'seoroom_reader_resolve_slug',
    ));
});

function seoroom_reader_check_key($req) {
    $key = $req->get_param('api_key');
    return ($key && hash_equals(SEOROOM_READER_KEY, (string) $key));
}

function seoroom_reader_get_elementor($req) {
    if (!seoroom_reader_check_key($req)) {
        return new WP_REST_Response(array('error' => 'invalid api_key'), 401);
    }
    $id = intval($req['id']);
    $post = get_post($id);
    if (!$post) return new WP_REST_Response(array('error' => 'not found'), 404);

    $data = get_post_meta($id, '_elementor_data', true);
    $ps   = get_post_meta($id, '_elementor_page_settings', true);

    return new WP_REST_Response(array(
        'id'             => $id,
        'title'          => get_the_title($id),
        'slug'           => $post->post_name,
        'edit_mode'      => get_post_meta($id, '_elementor_edit_mode', true),
        'elementor_data' => is_string($data) ? $data : wp_json_encode($data),
        'page_settings'  => is_string($ps) ? $ps : wp_json_encode($ps),
    ), 200);
}

function seoroom_reader_resolve_slug($req) {
    if (!seoroom_reader_check_key($req)) {
        return new WP_REST_Response(array('error' => 'invalid api_key'), 401);
    }
    $slug = sanitize_title($req->get_param('slug'));
    if (!$slug) return new WP_REST_Response(array('error' => 'slug required'), 400);
    $page = get_page_by_path($slug, OBJECT, array('page', 'post'));
    if (!$page) {
        // try any post type
        $q = get_posts(array('name' => $slug, 'post_type' => 'any', 'post_status' => 'any', 'numberposts' => 1));
        if (!empty($q)) $page = $q[0];
    }
    if (!$page) return new WP_REST_Response(array('error' => 'not found'), 404);
    return new WP_REST_Response(array('id' => $page->ID, 'slug' => $page->post_name, 'type' => $page->post_type), 200);
}
