<?php
/**
 * Plugin Name: SEO Room Auth Fix
 * Description: Fixes REST API Application Password auth on hosts that strip the Authorization header.
 * Version: 1.0
 * Author: SEO Room
 */

add_action('init', function() {
    if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $_SERVER['HTTP_AUTHORIZATION'] = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
        list($type, $creds) = array_pad(explode(' ', $_SERVER['HTTP_AUTHORIZATION'], 2), 2, '');
        if (strtolower($type) === 'basic') {
            $decoded = base64_decode($creds);
            if ($decoded) {
                list($user, $pass) = explode(':', $decoded, 2);
                $_SERVER['PHP_AUTH_USER'] = $user;
                $_SERVER['PHP_AUTH_PW'] = $pass;
            }
        }
    }
}, 1);
