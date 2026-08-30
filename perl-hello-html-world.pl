#!/usr/bin/perl

print "Cache-Control: no-cache\n";
print "Content-Type: text/html\n\n";

print "<!DOCTYPE html>";
print "<html>";
print "<head>";
print "<title>Hello CGI World - Shekar Krishnamoorthy</title>";
print "</head>";
print "<body>";

print "<h1 align=center>Hello HTML World - Shekar Krishnamoorthy</h1><hr/>";
print "<p>Hello World, from Shekar Krishnamoorthy</p>";
print "<p>This page was generated with the Perl programming langauge</p>";

$date = localtime();
print "<p>This program was generated at: $date</p>";

# IP Address is an environment variable when using CGI
$address = $ENV{REMOTE_ADDR};
print "<p>Your current IP Address is: $address</p>";

print "</body>";
print "</html>";
